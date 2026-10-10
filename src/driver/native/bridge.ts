/**
 * Typed client for the in-app verify bridge (`orbital-ffi` `verify-bridge`,
 * 127.0.0.1) and the HTTP transport both native drivers share. Bodies are
 * validated with zod at the boundary; a body that does not fit is an error,
 * never a default.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { EventPayloadSchema, EntityRowSchema, SExprSchema } from '@almadar/core';
import type { EffectTrace, EntityRow, EventLogEntry, EventPayload, TransitionTrace } from '@almadar/core';

export interface HttpResponse {
  status: number;
  text: string;
}

/** The transport seam: a fake in tests, `fetch` in production. */
export interface HttpClient {
  request(method: 'GET' | 'POST', url: string, body?: string): Promise<HttpResponse>;
  requestBytes(url: string): Promise<Uint8Array>;
}

export function createFetchHttpClient(timeoutMs = 15_000): HttpClient {
  return {
    async request(method, url, body) {
      const res = await fetch(url, {
        method,
        ...(body !== undefined && { body, headers: { 'Content-Type': 'application/json' } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    },
    async requestBytes(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

const persistActionSchema = z.enum(['create', 'update', 'delete', 'batch']);

/**
 * `EffectTrace.action` is the persist mutation. The bridge fills the field for
 * other effect kinds too (a `set` carries its target there), so it is read only
 * where the effect's own `type` declares a persist.
 */
const effectSchema = z
  .object({
    type: z.string(),
    entityName: z.string().optional(),
    action: z.string().optional(),
    outcome: z.enum(['success', 'denied', 'failed']).optional(),
    args: z.array(SExprSchema),
    status: z.enum(['executed', 'failed', 'skipped']),
    error: z.string().optional(),
  })
  .transform(({ action, ...rest }): EffectTrace => {
    if (rest.type !== 'persist' || action === undefined) return rest;
    return { ...rest, action: persistActionSchema.parse(action) };
  });

const serverResponseSchema = z.object({
  orbitalName: z.string(),
  success: z.boolean(),
  transitioned: z.boolean(),
  clientEffects: z.number(),
  dataEntities: z.record(z.number()),
  emittedEvents: z.array(z.string()),
  error: z.string().optional(),
  timestamp: z.number(),
});

const transitionSchema = z.object({
  id: z.string(),
  traitName: z.string(),
  from: z.string(),
  to: z.string(),
  event: z.string(),
  effects: z.array(effectSchema),
  serverResponse: serverResponseSchema.optional(),
  timestamp: z.number(),
});

const snapshotSchema = z.object({
  traits: z.array(
    z.object({
      traitName: z.string(),
      currentState: z.string(),
      states: z.array(z.string()),
      events: z.array(z.string()),
    }),
  ),
  transitions: z.array(transitionSchema),
  transitionsDropped: z.number(),
  route: z.string().nullable(),
});

const eventSchema = z.object({
  type: z.string(),
  payload: EventPayloadSchema.optional(),
  source: z.object({ trait: z.string().optional() }).optional(),
  timestamp: z.number(),
});

export const SERVER_LEG_FAILED_EVENT = 'server-leg-failed';

/** Payload of a `server-leg-failed` event-log entry: the dispatched event, the orbital it was forwarded to and why the round trip failed. */
export const serverLegFailedSchema = z.object({ orbital: z.string(), event: z.string(), error: z.string() });
export type ServerLegFailed = z.infer<typeof serverLegFailedSchema>;

const eventsSchema = z.object({ entries: z.array(eventSchema), next: z.number(), dropped: z.number() });
const entitiesSchema = z.object({ rows: z.array(EntityRowSchema) });
const stateSchema = z.object({ state: z.string() });
const idleSchema = z.object({ idle: z.boolean(), ready: z.boolean(), pending: z.number(), queuedSends: z.number() });

export interface BridgeTrait {
  traitName: string;
  currentState: string;
  states: string[];
  events: string[];
}

export interface BridgeSnapshot {
  traits: BridgeTrait[];
  transitions: TransitionTrace[];
  transitionsDropped: number;
  /** The renderer's current route, or null when the host has not resolved one. */
  route: string | null;
}

export interface BridgeEvents {
  entries: EventLogEntry[];
  next: number;
  dropped: number;
}

export interface BridgeIdle {
  idle: boolean;
  /** False while the host is still mounting: its page-mount INIT dispatches are not all issued yet. */
  ready: boolean;
  pending: number;
  queuedSends: number;
}

export interface SendOutcome {
  accepted: boolean;
  status: number;
  detail: string;
}

export interface BridgeClient {
  health(): Promise<boolean>;
  snapshot(): Promise<BridgeSnapshot>;
  state(traitName: string): Promise<string | null>;
  events(since: number): Promise<BridgeEvents>;
  entities(name: string): Promise<EntityRow[]>;
  idle(): Promise<BridgeIdle>;
  send(event: string, payload: EventPayload, traitScope?: string): Promise<SendOutcome>;
}

export function createBridgeClient(http: HttpClient, port: number, host = '127.0.0.1'): BridgeClient {
  const base = `http://${host}:${port}`;

  async function getJson<T, I>(path: string, schema: z.ZodType<T, z.ZodTypeDef, I>): Promise<T> {
    const res = await http.request('GET', `${base}${path}`);
    if (res.status !== 200) throw new Error(`verify bridge GET ${path} -> ${res.status}: ${res.text}`);
    return schema.parse(JSON.parse(res.text));
  }

  return {
    async health() {
      try {
        const res = await http.request('GET', `${base}/health`);
        return res.status === 200;
      } catch {
        return false;
      }
    },
    snapshot: () => getJson('/snapshot', snapshotSchema),
    async state(traitName) {
      const { state } = await getJson(`/state?trait=${encodeURIComponent(traitName)}`, stateSchema);
      return state === '' ? null : state;
    },
    events: (since) => getJson(`/events?since=${since}`, eventsSchema),
    async entities(name) {
      return (await getJson(`/entities?name=${encodeURIComponent(name)}`, entitiesSchema)).rows;
    },
    idle: () => getJson('/idle', idleSchema),
    async send(event, payload, traitScope) {
      const body = JSON.stringify({
        event,
        ...(Object.keys(payload).length > 0 && { payload }),
        ...(traitScope !== undefined && { traitScope }),
      });
      const res = await http.request('POST', `${base}/send`, body);
      return { accepted: res.status === 202, status: res.status, detail: res.text };
    },
  };
}
