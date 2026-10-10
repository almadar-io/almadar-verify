import { describe, it, expect } from 'vitest';
import { createBridgeClient, type HttpClient, type HttpResponse } from '../bridge.js';

interface Call {
  method: string;
  url: string;
  body?: string;
}

function scripted(routes: Record<string, HttpResponse>): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = {
    async request(method, url, body) {
      calls.push({ method, url, ...(body !== undefined && { body }) });
      const hit = routes[`${method} ${new URL(url).pathname}${new URL(url).search}`];
      if (hit === undefined) throw new Error(`unscripted ${method} ${url}`);
      return hit;
    },
    async requestBytes() {
      return new Uint8Array();
    },
  };
  return { http, calls };
}

const ok = (body: object): HttpResponse => ({ status: 200, text: JSON.stringify(body) });

describe('bridge client', () => {
  it('parses /snapshot into core trace types', async () => {
    const { http } = scripted({
      'GET /snapshot': ok({
        traits: [{ traitName: 'TaskBrowse', currentState: 'listing', states: ['listing'], events: ['INIT'] }],
        transitions: [
          {
            id: 't-1', traitName: 'TaskBrowse', from: 'idle', to: 'listing', event: 'INIT', timestamp: 5,
            effects: [{ type: 'fetch', entityName: 'Task', args: [['fetch', 'Task']], status: 'executed' }],
            serverResponse: { orbitalName: 'Tasks', success: true, transitioned: true, clientEffects: 1, dataEntities: { Task: 2 }, emittedEvents: [], timestamp: 6 },
          },
        ],
        transitionsDropped: 0,
        route: '/tasks',
      }),
    });
    const snap = await createBridgeClient(http, 7357).snapshot();
    expect(snap.traits[0]?.currentState).toBe('listing');
    expect(snap.transitions[0]?.serverResponse?.dataEntities).toEqual({ Task: 2 });
    expect(snap.route).toBe('/tasks');
  });

  it('keeps a null route as null; control: a body without route is rejected, not defaulted', async () => {
    const { http } = scripted({ 'GET /snapshot': ok({ traits: [], transitions: [], transitionsDropped: 0, route: null }) });
    expect((await createBridgeClient(http, 7357).snapshot()).route).toBeNull();
    const { http: bare } = scripted({ 'GET /snapshot': ok({ traits: [], transitions: [], transitionsDropped: 0 }) });
    await expect(createBridgeClient(bare, 7357).snapshot()).rejects.toThrow();
  });

  it('keeps a persist mutation but ignores the bridge\'s set-target in action', async () => {
    const effect = (over: object) => ({ args: [], status: 'executed', ...over });
    const { http } = scripted({
      'GET /snapshot': ok({
        traits: [],
        transitionsDropped: 0,
        route: null,
        transitions: [{
          id: 't-1', traitName: 'T', from: 'a', to: 'b', event: 'E', timestamp: 1,
          effects: [
            effect({ type: 'set', action: '@entity.id' }),
            effect({ type: 'persist', action: 'create', entityName: 'Task' }),
            effect({ type: 'persist', entityName: 'Task' }),
          ],
        }],
      }),
    });
    const effects = (await createBridgeClient(http, 7357).snapshot()).transitions[0]!.effects;
    expect(effects[0]).not.toHaveProperty('action');
    expect(effects[1]?.action).toBe('create');
    expect(effects[2]).not.toHaveProperty('action');
  });

  it('control: a persist with an unknown mutation is rejected, not defaulted', async () => {
    const { http } = scripted({
      'GET /snapshot': ok({
        traits: [], transitionsDropped: 0, route: null,
        transitions: [{ id: 't', traitName: 'T', from: 'a', to: 'b', event: 'E', timestamp: 1, effects: [{ type: 'persist', action: 'upsert', args: [], status: 'executed' }] }],
      }),
    });
    await expect(createBridgeClient(http, 7357).snapshot()).rejects.toThrow();
  });

  it('rejects a /snapshot body that does not fit the contract', async () => {
    const { http } = scripted({ 'GET /snapshot': ok({ traits: [], transitions: [{ id: 1 }], transitionsDropped: 0, route: null }) });
    await expect(createBridgeClient(http, 7357).snapshot()).rejects.toThrow();
  });

  it('maps an empty /state to null; control: a named state is returned', async () => {
    const { http } = scripted({
      'GET /state?trait=A': ok({ state: '' }),
      'GET /state?trait=B': ok({ state: 'listing' }),
    });
    const bridge = createBridgeClient(http, 7357);
    expect(await bridge.state('A')).toBeNull();
    expect(await bridge.state('B')).toBe('listing');
  });

  it('encodes the trait query parameter', async () => {
    const { http, calls } = scripted({ 'GET /state?trait=A%20B': ok({ state: 's' }) });
    await createBridgeClient(http, 7357).state('A B');
    expect(calls[0]?.url).toContain('trait=A%20B');
  });

  it('POSTs /send with payload and scope; accepted only on 202', async () => {
    const { http, calls } = scripted({ 'POST /send': { status: 202, text: '{"accepted":true}' } });
    const out = await createBridgeClient(http, 7357).send('EDIT', { id: '5' }, 'Tasks.TaskBrowse');
    expect(out.accepted).toBe(true);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ event: 'EDIT', payload: { id: '5' }, traitScope: 'Tasks.TaskBrowse' });
  });

  it('omits an empty payload and an absent scope; a 409 is not accepted', async () => {
    const { http, calls } = scripted({ 'POST /send': { status: 409, text: '{"error":"no dispatch callback registered by the host"}' } });
    const out = await createBridgeClient(http, 7357).send('INIT', {});
    expect(out).toMatchObject({ accepted: false, status: 409 });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ event: 'INIT' });
  });

  it('health is false on transport failure, true on 200', async () => {
    const down: HttpClient = { request: async () => { throw new Error('ECONNREFUSED'); }, requestBytes: async () => new Uint8Array() };
    expect(await createBridgeClient(down, 7357).health()).toBe(false);
    const { http } = scripted({ 'GET /health': ok({ ok: true }) });
    expect(await createBridgeClient(http, 7357).health()).toBe(true);
  });

  it('a non-200 read surfaces the status and body', async () => {
    const { http } = scripted({ 'GET /entities?name=X': { status: 400, text: '{"error":"unknown entity"}' } });
    await expect(createBridgeClient(http, 7357).entities('X')).rejects.toThrow(/400.*unknown entity/);
  });

  it('reads /events with its cursor', async () => {
    const { http } = scripted({
      'GET /events?since=3': ok({ entries: [{ type: 'UI:EDIT', source: { trait: 'T' }, timestamp: 1 }], next: 4, dropped: 0 }),
    });
    const page = await createBridgeClient(http, 7357).events(3);
    expect(page.next).toBe(4);
    expect(page.entries[0]?.type).toBe('UI:EDIT');
  });

  it('parses /idle including ready', async () => {
    const { http } = scripted({ 'GET /idle': ok({ idle: false, ready: false, pending: 0, queuedSends: 0 }) });
    expect(await createBridgeClient(http, 7357).idle()).toEqual({ idle: false, ready: false, pending: 0, queuedSends: 0 });
  });

  it('rejects an /idle answer without ready: a host that predates the signal cannot pass for settled', async () => {
    const { http } = scripted({ 'GET /idle': ok({ idle: true, pending: 0, queuedSends: 0 }) });
    await expect(createBridgeClient(http, 7357).idle()).rejects.toThrow();
  });
});
