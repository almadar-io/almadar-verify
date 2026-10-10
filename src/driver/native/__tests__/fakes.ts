import type { EntityRow, EventPayload } from '@almadar/core';
import type { BridgeClient, BridgeEvents, BridgeIdle, BridgeSnapshot, SendOutcome } from '../bridge.js';
import type { NativeDevice } from '../device.js';
import type { NativeElement } from '../tree.js';
import type { TraitWalkConfig } from '../../../engine/types.js';
import type { ExtendedWalkStep } from '../../../planner/types.js';

export const trait: TraitWalkConfig = { traitName: 'TaskBrowse', initialState: 'listing', transitions: [] };

export function step(over: Partial<ExtendedWalkStep>): ExtendedWalkStep {
  return {
    from: 'listing',
    to: 'listing',
    event: 'EDIT',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    traitName: trait.traitName,
    triggerKind: 'dom',
    coverageKey: 'TaskBrowse:listing+EDIT->listing',
    ...over,
  };
}

export interface Tap {
  id: string;
  within?: string;
}

export interface Typed {
  id: string;
  text: string;
}

export class FakeDevice implements NativeDevice {
  taps: Tap[] = [];
  typed: Typed[] = [];
  screenshots: string[] = [];
  relaunches = 0;
  relaunchEnvs: Array<Readonly<Record<string, string>> | undefined> = [];
  /** Trees served in order; the last one repeats. */
  constructor(
    public trees: NativeElement[][],
    private readonly refuse: ReadonlySet<string> = new Set(),
  ) {}
  private reads = 0;
  async readTree(): Promise<NativeElement[]> {
    const tree = this.trees[Math.min(this.reads, this.trees.length - 1)]!;
    this.reads++;
    return tree;
  }
  async tap(element: NativeElement, within?: string): Promise<boolean> {
    if (this.refuse.has(element.id)) return false;
    this.taps.push({ id: element.id, ...(within !== undefined && { within }) });
    return true;
  }
  async typeText(element: NativeElement, text: string): Promise<boolean> {
    this.typed.push({ id: element.id, text });
    return true;
  }
  async screenshot(path: string): Promise<void> {
    this.screenshots.push(path);
  }
  async relaunch(env?: Readonly<Record<string, string>>): Promise<void> {
    this.relaunches++;
    this.relaunchEnvs.push(env);
  }
}

export class FakeBridge implements BridgeClient {
  sent: Array<{ event: string; payload: EventPayload; traitScope?: string }> = [];
  sendStatus = 202;
  healthAnswers: boolean[] = [true];
  idleAnswers: BridgeIdle[] = [{ idle: true, ready: true, pending: 0, queuedSends: 0 }];
  routeAnswers: Array<string | null> | null = null;
  private routeReads = 0;
  snapshotValue: BridgeSnapshot = { traits: [], transitions: [], transitionsDropped: 0, route: null };
  eventPages: BridgeEvents[] = [{ entries: [], next: 0, dropped: 0 }];
  eventSinceCalls: number[] = [];
  entityRows: Record<string, EntityRow[]> = {};
  states: Record<string, string | null> = {};
  private healthReads = 0;
  idleReads = 0;
  private eventReads = 0;
  async health() {
    return this.healthAnswers[Math.min(this.healthReads++, this.healthAnswers.length - 1)]!;
  }
  async snapshot() {
    if (this.routeAnswers === null) return this.snapshotValue;
    return { ...this.snapshotValue, route: this.routeAnswers[Math.min(this.routeReads++, this.routeAnswers.length - 1)]! };
  }
  async state(traitName: string) {
    return this.states[traitName] ?? null;
  }
  async events(since: number) {
    this.eventSinceCalls.push(since);
    return this.eventPages[Math.min(this.eventReads++, this.eventPages.length - 1)]!;
  }
  async entities(name: string) {
    return this.entityRows[name] ?? [];
  }
  async idle() {
    return this.idleAnswers[Math.min(this.idleReads++, this.idleAnswers.length - 1)]!;
  }
  async send(event: string, payload: EventPayload, traitScope?: string): Promise<SendOutcome> {
    this.sent.push({ event, payload, ...(traitScope !== undefined && { traitScope }) });
    return { accepted: this.sendStatus === 202, status: this.sendStatus, detail: '' };
  }
}

export function fakeClock(): { sleep: (ms: number) => Promise<void>; now: () => number } {
  let t = 0;
  return {
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
}
