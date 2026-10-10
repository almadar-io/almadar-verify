/**
 * `createNativeDriver` — the `Driver<Ctx>` for a native app (iOS Simulator or
 * Android emulator) the walker drives exactly as it drives the web:
 *
 * - observations (state, transitions, event log, entities, idle) come from the
 *   in-app verify bridge, which sits on the host's real dispatch path;
 * - affordances are located in the accessibility tree by the core selector
 *   contract and tapped through the platform {@link NativeDevice};
 * - a missing affordance returns `false` so the kernel falls back to
 *   `sendEvent`, the same contract as the web trigger.
 *
 * @packageDocumentation
 */

import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createLogger } from '@almadar/logger';
import { FORM_PATTERN, NATIVE_ID_PREFIX, isEventPayloadValue, nativePatternId } from '@almadar/core';
import type { EntityData, EntityRow, EventLogEntry, EventPayload, FieldValue, ServerResponseTrace, VerificationSnapshot } from '@almadar/core';
import type { Driver, DomTriggerResult, DriverContext, SendResult, SnapshotResult } from '../types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';
import { generateFieldValue } from '../../browser/interaction.js';
import { lastEffectResultsFor, lastServerResponseFor } from '../helpers/default-snapshot.js';
import { frameScreenshotFileName } from '../helpers/frame-screenshot-name.js';
import { SERVER_LEG_FAILED_EVENT, serverLegFailedSchema, type BridgeClient, type BridgeSnapshot, type ServerLegFailed } from './bridge.js';
import type { NativeDevice } from './device.js';
import {
  actionIsRowTagged,
  firstRowId,
  resolveAction,
  resolveField,
  resolveOverflow,
  treeToDomSnapshot,
  fieldsInside,
  type AffordanceScope,
  type NativeElement,
  type ResolvedAffordance,
} from './tree.js';

const log = createLogger('almadar:verify:native');

export interface SettleTimeout {
  trait: string;
  waitedMs: number;
  /** False when the host never finished mounting, so the pending counters were not yet meaningful. */
  ready: boolean;
  pending: number;
  queuedSends: number;
}

/** A relaunch whose bridge answered /health but never reported the host mounted. */
export interface ReadyTimeout {
  trait: string;
  waitedMs: number;
}

export interface RouteTimeout {
  trait: string;
  expected: string;
  /** The route the bridge last reported, or null when it reported none. */
  actual: string | null;
  waitedMs: number;
}

export const INITIAL_ROUTE_ENV = 'ORBITAL_INITIAL_ROUTE';

/** What the driver saw go wrong without it being a step finding; the orchestrator folds these into the report. */
export interface NativeDriverDiagnostics {
  settleTimeouts: SettleTimeout[];
  treeFailures: string[];
  /** Snapshots whose bridge reported no route, so `DomSnapshot.url` was left empty. */
  routeUnavailable: number;
  /** Bridge entries the driver could not interpret. */
  bridgeFailures: string[];
  /** Relaunches at a trait's route whose bridge never reported that route. */
  routeTimeouts: RouteTimeout[];
  /** Relaunches whose host never reported its page-mount INIT dispatches as issued. */
  readyTimeouts: ReadyTimeout[];
}

export interface NativeDriverOptions {
  device: NativeDevice;
  bridge: BridgeClient;
  /** Entity names whose rows `snapshot` reads from the bridge (the schema's entities). */
  entityNames: ReadonlyArray<string>;
  screenshots?: boolean;
  settleTimeoutMs?: number;
  /** Consecutive idle reads, `settlePollMs` apart, that count as settled. */
  settleStableReads?: number;
  settlePollMs?: number;
  rowsMountTimeoutMs?: number;
  formMountTimeoutMs?: number;
  cascadeTimeoutMs?: number;
  healthTimeoutMs?: number;
  routeTimeoutMs?: number;
  readyTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type NativeDriver = Driver<DriverContext> & { readonly diagnostics: NativeDriverDiagnostics };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function emptyRuntimeSnapshot(): VerificationSnapshot {
  return { checks: [], transitions: [], bridge: null, summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 }, traits: [] };
}

function fieldText(value: FieldValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return null;
}

function rowSignature(rows: ReadonlyArray<EntityRow>): string {
  return [...rows]
    .filter((r): r is EntityRow & { id: string } => typeof r.id === 'string')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => `${r.id}:${typeof r.updatedAt === 'string' ? r.updatedAt : ''}`)
    .join('|');
}

export function createNativeDriver(options: NativeDriverOptions): NativeDriver {
  const {
    device,
    bridge,
    entityNames,
    screenshots = true,
    settleTimeoutMs = 10_000,
    settleStableReads = 2,
    settlePollMs = 150,
    rowsMountTimeoutMs = 5_000,
    formMountTimeoutMs = 3_000,
    cascadeTimeoutMs = 8_000,
    healthTimeoutMs = 60_000,
    routeTimeoutMs = 15_000,
    readyTimeoutMs = 30_000,
    sleep = defaultSleep,
    now = Date.now,
  } = options;

  const diagnostics: NativeDriverDiagnostics = {
    settleTimeouts: [],
    treeFailures: [],
    routeUnavailable: 0,
    bridgeFailures: [],
    routeTimeouts: [],
    readyTimeouts: [],
  };
  let eventCursor = 0;
  const formId = nativePatternId(FORM_PATTERN);

  async function readTree(): Promise<NativeElement[]> {
    try {
      return await device.readTree();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.treeFailures.push(message);
      log.warn('native:tree:read-failed', { error: message });
      return [];
    }
  }

  async function pollTree(until: (tree: NativeElement[]) => boolean, timeoutMs: number): Promise<NativeElement[]> {
    const deadline = now() + timeoutMs;
    for (;;) {
      const tree = await readTree();
      if (until(tree) || now() >= deadline) return tree;
      await sleep(250);
    }
  }

  function serverLegFailureFor(entries: ReadonlyArray<EventLogEntry>, event: string | undefined): { failure: ServerLegFailed; timestamp: number } | null {
    let found: { failure: ServerLegFailed; timestamp: number } | null = null;
    for (const entry of entries) {
      if (entry.type !== SERVER_LEG_FAILED_EVENT) continue;
      const parsed = serverLegFailedSchema.safeParse(entry.payload);
      if (!parsed.success) {
        const message = `${SERVER_LEG_FAILED_EVENT} entry does not fit {orbital, event, error}: ${parsed.error.message}`;
        diagnostics.bridgeFailures.push(message);
        log.warn('native:server-leg-failed:malformed', { error: message });
        continue;
      }
      if (event !== undefined && parsed.data.event === event) found = { failure: parsed.data, timestamp: entry.timestamp };
    }
    return found;
  }

  async function entityRows(name: string): Promise<EntityRow[]> {
    return bridge.entities(name);
  }

  async function absoluteTransitionCount(): Promise<number> {
    const snap = await bridge.snapshot();
    return snap.transitionsDropped + snap.transitions.length;
  }

  async function fillFormFields(step: ExtendedWalkStep): Promise<void> {
    const data = step.formData;
    if (data === undefined) return;
    await pollTree((tree) => tree.some((el) => el.id === formId), formMountTimeoutMs);
    for (const [name, value] of Object.entries(data)) {
      const text = value === null || value === undefined ? null : fieldText(value);
      if (text === null) {
        log.debug('native:fill:skipped', { name, reason: 'no scalar text form' });
        continue;
      }
      const tree = await readTree();
      const field = resolveField(tree, name);
      if (field === null) {
        log.debug('native:fill:field-absent', { name });
        continue;
      }
      const typed = await device.typeText(field, text);
      log.debug('native:fill:field', { name, typed });
    }
  }

  async function fillOwningForm(tree: NativeElement[]): Promise<void> {
    for (const field of fieldsInside(tree, formId)) {
      const name = field.id.slice(NATIVE_ID_PREFIX.field.length);
      await device.typeText(field, generateFieldValue('text', name));
    }
  }

  async function awaitCascade(step: ExtendedWalkStep, baselineTx: number, baselineSignature: string, entityName: string | null): Promise<void> {
    const expected = step.expectedSuccessEvent;
    if (expected === undefined) {
      await sleep(1_500);
      return;
    }
    const deadline = now() + cascadeTimeoutMs;
    for (;;) {
      const snap = await bridge.snapshot();
      const slice = snap.transitions.slice(Math.max(0, baselineTx - snap.transitionsDropped));
      const landed = slice.some((t) => t.event === expected || (t.serverResponse?.emittedEvents ?? []).includes(expected));
      if (landed) {
        if (entityName === null) return;
        if (rowSignature(await entityRows(entityName)) !== baselineSignature) return;
      }
      if (now() >= deadline) {
        log.warn('native:cascade:wait-timeout', { step: step.coverageKey, expected });
        return;
      }
      await sleep(100);
    }
  }

  async function deleteByPayload(step: ExtendedWalkStep, traitName: string): Promise<boolean> {
    if (step.expectedRowDelta === undefined) return false;
    const rows = (await entityRows(step.expectedRowDelta.entityName)).filter(
      (r): r is EntityRow & { id: string } => typeof r.id === 'string',
    );
    const row =
      step.targetRowId !== undefined
        ? rows.find((r) => r.id === step.targetRowId)
        : [...rows].sort((a, b) => a.id.localeCompare(b.id))[0];
    if (row === undefined) {
      log.debug('native:delete:payload-dispatch', { step: step.coverageKey, delivered: false, reason: 'no-rows' });
      return false;
    }
    const payload: EventPayload = {};
    if (step.payloadRowShape !== undefined) {
      for (const field of step.payloadRowShape) {
        const value = field.wholeRow ? row : row[field.name];
        if (isEventPayloadValue(value)) payload[field.name] = value;
      }
    } else {
      payload.id = row.id;
    }
    const out = await bridge.send(step.event, payload, traitName);
    log.debug('native:delete:payload-dispatch', { step: step.coverageKey, rowId: row.id, delivered: out.accepted });
    return out.accepted;
  }

  async function tapResolved(hit: ResolvedAffordance): Promise<boolean> {
    return device.tap(hit.element, hit.within);
  }

  async function findAndTap(event: string, scope: AffordanceScope): Promise<{ tapped: boolean; tree: NativeElement[]; hit: ResolvedAffordance | null }> {
    const tree = await readTree();
    const hit = resolveAction(tree, event, scope);
    if (hit === null) return { tapped: false, tree, hit };
    return { tapped: await tapResolved(hit), tree, hit };
  }

  async function awaitReady(ctx: DriverContext): Promise<void> {
    const start = now();
    for (;;) {
      if ((await bridge.idle()).ready) return;
      if (now() - start >= readyTimeoutMs) break;
      await sleep(250);
    }
    const timeout: ReadyTimeout = { trait: ctx.trait.traitName, waitedMs: now() - start };
    diagnostics.readyTimeouts.push(timeout);
    log.warn('native:ready:timeout', { ...timeout });
  }

  async function settleIdle(ctx: DriverContext): Promise<void> {
    const start = now();
    let stable = 0;
    for (;;) {
      const idle = await bridge.idle();
      stable = idle.idle ? stable + 1 : 0;
      if (stable >= settleStableReads) return;
      if (now() - start >= settleTimeoutMs) {
        const timeout: SettleTimeout = { trait: ctx.trait.traitName, waitedMs: now() - start, ready: idle.ready, pending: idle.pending, queuedSends: idle.queuedSends };
        diagnostics.settleTimeouts.push(timeout);
        log.warn('native:settle:timeout', { ...timeout });
        return;
      }
      await sleep(settlePollMs);
    }
  }

  async function relaunchAt(ctx: DriverContext): Promise<void> {
    const route = ctx.trait.route;
    const expected = route === undefined || route === '' ? null : route.startsWith('/') ? route : `/${route}`;
    await device.relaunch(expected === null ? undefined : { [INITIAL_ROUTE_ENV]: expected });
    const healthDeadline = now() + healthTimeoutMs;
    while (!(await bridge.health())) {
      if (now() >= healthDeadline) throw new Error(`verify bridge did not answer /health within ${healthTimeoutMs}ms after relaunch`);
      await sleep(250);
    }
    eventCursor = 0;
    await awaitReady(ctx);
    if (expected !== null) await awaitRoute(ctx, expected);
    // The mount INIT server legs (and the cascade they deliver) must land before any step is sent.
    await settleIdle(ctx);
  }

  async function awaitRoute(ctx: DriverContext, expected: string): Promise<void> {
    const start = now();
    let actual: string | null = null;
    for (;;) {
      actual = (await bridge.snapshot()).route;
      if (actual === expected) return;
      if (now() - start >= routeTimeoutMs) break;
      await sleep(250);
    }
    const timeout: RouteTimeout = { trait: ctx.trait.traitName, expected, actual, waitedMs: now() - start };
    diagnostics.routeTimeouts.push(timeout);
    log.warn('native:route:timeout', { ...timeout });
  }

  const driver: Driver<DriverContext> = {
    async sendEvent(ctx, event, payload): Promise<SendResult> {
      // The host routes /send by bare trait name; the qualified `Orbital.Trait` scope is a web bus key.
      const traitName = ctx.trait.traitName;
      const out = await bridge.send(event, payload, traitName);
      if (!out.accepted) log.warn('native:send:refused', { event, traitName, status: out.status, detail: out.detail });
      return { sent: out.accepted, serverResponse: null };
    },

    getState: (_ctx, traitName) => bridge.state(traitName),

    async triggerDOM(ctx, step: ExtendedWalkStep): Promise<DomTriggerResult> {
      const isCrudFlow = step.testKind === 'crud-create' || step.testKind === 'crud-edit' || step.testKind === 'crud-delete';
      const needsRow = step.testKind === 'crud-edit' || step.testKind === 'crud-delete';
      const affordanceEvent = step.openAffordanceEvent ?? step.event;
      const scope: AffordanceScope = isCrudFlow && step.targetRowId !== undefined
        ? { rowId: `row-${step.targetRowId}` }
        : needsRow
          ? { firstRow: true }
          : {};

      if (needsRow) {
        const tree = await pollTree((t) => firstRowId(t) !== null, rowsMountTimeoutMs);
        log.debug('native:browse-loaded-gate', { step: step.coverageKey, rowsPresent: firstRowId(tree) !== null });
      }

      let { tapped, tree, hit } = await findAndTap(affordanceEvent, scope);
      if (hit !== null && tapped && step.payloadCase !== 'malformed' && hit.element.ancestors.includes(formId)) {
        // The form's own submit sends what the form holds; fill it first or it answers a validation failure.
        await fillOwningForm(tree);
        tapped = await tapResolved(hit);
      }

      if (!tapped && scope.rowId !== undefined && !actionIsRowTagged(tree, affordanceEvent)) {
        // The action is rendered without row tagging at all; its payload binds the row it belongs to.
        ({ tapped } = await findAndTap(affordanceEvent, {}));
      }

      if (!tapped && needsRow) {
        const overflow = resolveOverflow(tree, scope);
        if (overflow !== null && (await tapResolved(overflow))) {
          const menuTree = await readTree();
          const item = resolveAction(menuTree, affordanceEvent, { outsideRows: true });
          if (item !== null) tapped = await tapResolved(item);
          log.debug('native:trigger:overflow', { step: step.coverageKey, itemFound: item !== null, tapped });
        }
      }

      if (!tapped && step.testKind === 'crud-delete') tapped = await deleteByPayload(step, ctx.trait.traitName);

      if (!tapped) return needsRow && step.isRowAction !== false ? 'no-row-affordance' : false;

      if (step.formData !== undefined && Object.keys(step.formData).length > 0) await fillFormFields(step);

      if (isCrudFlow) {
        const followUp = step.submitEvent ?? step.confirmEvent;
        if (followUp !== undefined) {
          const entityName = step.expectedRowDelta?.entityName ?? null;
          const baselineTx = await absoluteTransitionCount();
          const baselineSignature = entityName === null ? '' : rowSignature(await entityRows(entityName));
          const target = await pollTree((t) => resolveAction(t, followUp, {}) !== null, formMountTimeoutMs);
          const followHit = resolveAction(target, followUp, {});
          const followTapped = followHit !== null && (await tapResolved(followHit));
          log.debug('native:click:follow-up', { step: step.coverageKey, followUp, followTapped });
          await awaitCascade(step, baselineTx, baselineSignature, entityName);
          await sleep(250);
        }
      }
      return true;
    },

    async snapshot(ctx, step): Promise<SnapshotResult> {
      const bridgeSnap: BridgeSnapshot = await bridge.snapshot();
      const page = await bridge.events(eventCursor);
      eventCursor = page.next;

      const entityData: EntityData = {};
      for (const name of entityNames) entityData[name] = await entityRows(name);

      const runtimeSnapshot: VerificationSnapshot = {
        ...emptyRuntimeSnapshot(),
        transitions: bridgeSnap.transitions,
        traits: bridgeSnap.traits.map((t) => ({
          traitName: t.traitName,
          currentState: t.currentState,
          states: t.states,
          events: t.events,
          data: entityData,
          cascadeReceived: [],
        })),
      };

      let screenshotPath: string | null = null;
      if (screenshots && step !== null) {
        screenshotPath = join(ctx.outputDir, 'frames', frameScreenshotFileName(ctx.trait.traitName, step));
        await mkdir(join(ctx.outputDir, 'frames'), { recursive: true });
        await device.screenshot(screenshotPath);
      }

      const tree = await readTree();
      if (bridgeSnap.route === null) {
        diagnostics.routeUnavailable++;
        log.warn('native:route:unavailable');
      }
      const rowsByEntity: Record<string, number> = {};
      for (const [name, rows] of Object.entries(entityData)) rowsByEntity[name] = rows.length;

      const recorded = lastServerResponseFor(runtimeSnapshot, ctx.trait.traitName, step?.event);
      const leg = serverLegFailureFor(page.entries, step?.event);
      const serverResponse: ServerResponseTrace | null =
        leg === null
          ? recorded
          : {
              orbitalName: leg.failure.orbital,
              transitioned: false,
              clientEffects: 0,
              dataEntities: {},
              emittedEvents: [],
              timestamp: leg.timestamp,
              ...recorded,
              success: false,
              error: leg.failure.error,
            };

      return {
        runtimeSnapshot,
        dom: treeToDomSnapshot(tree, bridgeSnap.route ?? '', rowsByEntity),
        consoleAdded: [],
        eventLogAdded: page.entries,
        effectResults: lastEffectResultsFor(runtimeSnapshot, ctx.trait.traitName, step?.event),
        serverResponse,
        entityData,
        screenshotPath,
      };
    },

    async beforeTrait(ctx) {
      await relaunchAt(ctx);
    },

    async reset(ctx) {
      await relaunchAt(ctx);
    },

    settle: settleIdle,

    async listEntityRows(_ctx, entityName) {
      return entityRows(entityName);
    },
  };

  return Object.assign(driver, { diagnostics });
}
