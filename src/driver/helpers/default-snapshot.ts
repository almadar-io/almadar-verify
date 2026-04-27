/**
 * `createDefaultSnapshot` — Playwright-side helper that produces a
 * `Driver.snapshot` implementation reading from
 * `window.__orbitalVerification.getSnapshot()`.
 *
 * Wraps existing `runtime/state-bridge.ts` readers + `ConsoleCollector`
 * + `takeScreenshot` so the new Driver impl doesn't reinvent any of
 * them. The Driver impl combines this with its own `sendEvent` /
 * `getState` glue.
 *
 * This file imports `playwright` (it's the only one in `driver/` that
 * does, beside `impls/playwright.ts`); the kernel itself never names
 * Playwright.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type {
  EffectTrace,
  EntityData,
  EventLogEntry,
  ServerResponseTrace,
  VerificationSnapshot,
} from '@almadar/core';
import type { ConsoleEntry } from '../../util/types.js';
import type { DomSnapshot } from '../../frame/types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';
import type { ConsoleCollector } from '../../browser/console.js';
import { readVerificationSnapshot, readEventLog } from '../../runtime/state-bridge.js';
import { takeScreenshot, safeFileName } from '../../browser/screenshot.js';
import { PORTAL_SLOTS, type PortalSlot } from '../../browser/portal-slots.js';
import { createLogger } from '../../logger.js';
import { join } from 'node:path';

// Permanent observability for the verifier's snapshot capture moment.
// Surfaces stale-state vs cascade-not-fired without re-instrumenting:
// each snapshot call logs which trait owns the frame, the per-entity
// row counts mergeEntityData saw, and the source of the
// trait-tagged serverResponse. Operators correlate these timestamps
// with `[almadar:server:data] list { count: N }` lines in server.log
// to determine whether a stale frame is a cascade-race or a
// snapshot-read-before-cascade.
const domLog = createLogger('almadar:verify:dom');

export interface DefaultSnapshotOptions {
  /** ConsoleCollector instance bound to the Page; used to capture JS-console deltas. */
  console: ConsoleCollector;
  /** Whether to capture screenshots. Default: true. */
  screenshots?: boolean;
}

/**
 * Build a `Driver.snapshot` function. Captures runtime + DOM + console
 * + event log + screenshot in one round-trip per call.
 */
export function createDefaultSnapshot(
  options: DefaultSnapshotOptions,
): (page: Page, outputDir: string, traitName: string, step: ExtendedWalkStep | null) => Promise<{
  runtimeSnapshot: VerificationSnapshot;
  dom: DomSnapshot;
  consoleAdded: ReadonlyArray<ConsoleEntry>;
  eventLogAdded: ReadonlyArray<EventLogEntry>;
  effectResults: ReadonlyArray<EffectTrace>;
  serverResponse: ServerResponseTrace | null;
  entityData: EntityData;
  screenshotPath: string | null;
}> {
  const { console: consoleCollector, screenshots = true } = options;
  let consoleSeen = 0;
  let eventLogSeen = 0;

  return async function snapshot(page, outputDir, traitName, step) {
    // Read the runtime snapshot.
    const runtimeSnapshot = (await readVerificationSnapshot(page)) ?? emptySnapshot();

    // Pull console deltas (collector accumulates; we slice the new tail).
    const allConsole = consoleCollector.getEntries();
    const consoleAdded = allConsole.slice(consoleSeen);
    consoleSeen = allConsole.length;

    // Pull bus event log deltas.
    const allEventLog = (await readEventLog(page)) ?? [];
    const eventLogAdded = allEventLog.slice(eventLogSeen);
    eventLogSeen = allEventLog.length;

    // Derive EntityData + counts from the runtime snapshot's per-trait
    // `data` maps. Each TraitStateSnapshot.data is keyed by entity name.
    const entityData = mergeEntityData(runtimeSnapshot);

    // Per-entity row counts the snapshot saw. Operators compare these
    // against `[almadar:server:data] list { count: N }` lines in
    // `<outputDir>/server.log` (timestamps line up via process clock)
    // to detect snapshot-staleness: server-side count grew but
    // verifier-side count didn't, which means the cascading
    // ListItem*.INIT re-fetch hadn't refreshed the React state at the
    // moment the snapshot was captured.
    const entityCountsForLog: Record<string, number> = {};
    for (const [name, rows] of Object.entries(entityData)) {
      entityCountsForLog[name] = rows.length;
    }
    const transitionCount = runtimeSnapshot.transitions.length;
    const traitCount = runtimeSnapshot.traits.length;
    domLog.debug('dom:snapshot:entity-data', {
      traitName,
      stepEvent: step?.event,
      stepTestKind: step?.testKind,
      entityCounts: entityCountsForLog as unknown as import('@almadar/core').LogMeta,
      traitCount,
      transitionCount,
    });

    // Effect results from the most recent transition for the named trait.
    const effectResults = lastEffectResultsFor(runtimeSnapshot, traitName);
    // Server response: try the trait-named transition first, then fall
    // back to the synthetic `server:<orbital>` transition the runtime path
    // records via recordServerResponse for the same event. Without the
    // fallback, runtime-verify cascades from server-bridge'd persists
    // (which carry their emit.success in the synthetic server entry, not
    // under the trait name) arrive as null.
    const serverResponse = lastServerResponseFor(
      runtimeSnapshot,
      traitName,
      step?.event,
    );
    domLog.debug('dom:snapshot:server-response', {
      traitName,
      stepEvent: step?.event,
      hasServerResponse: serverResponse !== null,
      serverResponseTrait: serverResponse?.orbitalName,
      success: serverResponse?.success,
      emittedEvents: serverResponse?.emittedEvents.join(','),
      error: serverResponse?.error,
    });

    // Probe portal slots from the live DOM. The runtime stamps
    // `id="slot-{name}"` on every mounted slot and `data-pattern` on
    // its top child. Without this, every per-slot verdict (VG1, portal
    // presence) sees an empty `portals` array and reports "slot not
    // mounted" even when the screenshot proves otherwise.
    const portals = await probePortals(page);

    // Optional screenshot.
    let screenshotPath: string | null = null;
    if (screenshots && step !== null) {
      // safeFileName strips dots, so sanitize the basename then append
      // the extension. Otherwise `.png` becomes `_png` and playwright
      // rejects with `unsupported mime type "null"`.
      //
      // Multiple steps with the same `from_event_to` cause (e.g. base
      // walk and interaction-test for the same transition) would
      // collide on the same filename, last-write-wins. Suffix with the
      // testKind so each variant gets its own screenshot file.
      const variant = step.testKind !== undefined ? `__${step.testKind}` : '';
      const fileName = `${safeFileName(`${traitName}_${step.from}_${step.event}_${step.to}${variant}`)}.png`;
      screenshotPath = join(outputDir, 'frames', fileName);
      await takeScreenshot(page, screenshotPath);
    }

    return {
      runtimeSnapshot,
      dom: {
        url: page.url(),
        rowsByEntity: rowCounts(entityData),
        portals,
        visibleTextSample: '',
      },
      consoleAdded,
      eventLogAdded,
      effectResults,
      serverResponse,
      entityData,
      screenshotPath,
    };
  };
}

// ── internal ─────────────────────────────────────────────────────────

function emptySnapshot(): VerificationSnapshot {
  return {
    checks: [],
    transitions: [],
    bridge: null,
    summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
    traits: [],
  };
}

function mergeEntityData(snap: VerificationSnapshot): EntityData {
  const out: EntityData = {};
  for (const trait of snap.traits) {
    for (const [name, rows] of Object.entries(trait.data)) {
      // Last writer wins; per-trait stores typically agree on entity contents.
      out[name] = rows;
    }
  }
  return out;
}

function rowCounts(data: EntityData): { [name: string]: number } {
  const out: { [name: string]: number } = {};
  for (const [name, rows] of Object.entries(data)) {
    out[name] = rows.length;
  }
  return out;
}

function lastEffectResultsFor(snap: VerificationSnapshot, traitName: string): EffectTrace[] {
  const recent = [...snap.transitions].reverse().find((t) => t.traitName === traitName);
  return recent?.effects ?? [];
}

function lastServerResponseFor(
  snap: VerificationSnapshot,
  traitName: string,
  event?: string,
): ServerResponseTrace | null {
  // 1) Per-trait transition (client-side capture of the trait's own emits,
  //    e.g. from useTraitStateMachine's wrapped handlers.emit).
  const reversed = [...snap.transitions].reverse();
  const traitMatch = reversed.find(
    (t) => t.traitName === traitName && t.serverResponse !== undefined,
  );
  if (traitMatch?.serverResponse) return traitMatch.serverResponse;

  // 2) Server-bridge synthetic transition (recordServerResponse writes
  //    `traitName: "server:<orbital>"` and the response carries the
  //    cross-trait emit cascade). Match by event so concurrent server
  //    responses for different events don't collide.
  if (event !== undefined) {
    const serverMatch = reversed.find(
      (t) =>
        t.traitName.startsWith('server:') &&
        t.event === event &&
        t.serverResponse !== undefined,
    );
    if (serverMatch?.serverResponse) return serverMatch.serverResponse;
  }

  return null;
}

/**
 * Probe every canonical portal slot in the live DOM. Reports which are
 * mounted (`#slot-{name}` element exists) and the child element count.
 * `data-pattern` on the slot's first child is recorded by `assertPortalPerStep`
 * via the `portals` array (top-level pattern only — nested patterns are
 * not enumerated here).
 */
async function probePortals(page: Page): Promise<ReadonlyArray<{ slot: PortalSlot; mounted: boolean; childCount: number }>> {
  try {
    const slots = PORTAL_SLOTS as ReadonlyArray<PortalSlot>;
    const results = await page.evaluate((slotNames: ReadonlyArray<string>) => {
      return slotNames.map((name) => {
        const el = document.getElementById(`slot-${name}`);
        if (el === null) return { slot: name, mounted: false, childCount: 0 };
        return { slot: name, mounted: true, childCount: el.children.length };
      });
    }, slots as unknown as string[]);
    return results as ReadonlyArray<{ slot: PortalSlot; mounted: boolean; childCount: number }>;
  } catch {
    // Page may have navigated mid-snapshot; return empty so verdicts
    // surface as "slot not mounted" instead of crashing the run.
    return [];
  }
}
