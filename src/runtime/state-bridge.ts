/**
 * State bridge: read window.__orbitalVerification from a Playwright page.
 *
 * The OrbitalVerificationAPI is exposed by @almadar/ui's verificationRegistry.ts
 * on window.__orbitalVerification. This module provides typed access to it.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { RuntimeState } from '../util/types.js';

/** Shape of window.__orbitalVerification (subset used by verify tools) */
export interface OrbitalVerificationSnapshot {
  checks: Array<{
    id: string;
    label: string;
    status: 'pass' | 'fail' | 'pending' | 'warn';
    details?: string;
  }>;
  transitions: Array<{
    id: string;
    traitName: string;
    from: string;
    to: string;
    event: string;
    effects: Array<{ type: string; status: string; error?: string }>;
  }>;
  bridge: { connected: boolean } | null;
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
    pending: number;
  };
}

/**
 * Read the verification snapshot from the browser.
 * Returns null if the API is not available (runtime not loaded).
 */
export async function readVerificationSnapshot(
  page: Page
): Promise<OrbitalVerificationSnapshot | null> {
  return page.evaluate(() => {
    const api = (window as unknown as Record<string, unknown>).__orbitalVerification as
      | { getSnapshot?: () => OrbitalVerificationSnapshot }
      | undefined;
    return api?.getSnapshot?.() ?? null;
  });
}

/**
 * Read trait states from the verification API.
 * Returns a map of trait name -> current state name.
 */
export async function readTraitStates(
  page: Page
): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const api = (window as unknown as Record<string, unknown>).__orbitalVerification as
      | { getTraitState?: (name: string) => { currentState: string } | null }
      | undefined;
    if (!api?.getTraitState) return {};

    // We can't enumerate trait names from the API directly, so
    // use the snapshot's transitions to discover trait names.
    const snapshotApi = api as unknown as { getSnapshot?: () => OrbitalVerificationSnapshot };
    const snapshot = snapshotApi.getSnapshot?.();
    if (!snapshot) return {};

    const result: Record<string, string> = {};
    const traitNames = new Set(snapshot.transitions.map((t) => t.traitName));
    for (const name of traitNames) {
      const state = api.getTraitState(name);
      if (state) result[name] = state.currentState;
    }
    return result;
  });
}

/**
 * Read the event log from the verification API.
 */
export async function readEventLog(
  page: Page
): Promise<Array<{ event: string; listenerCount?: number }>> {
  return page.evaluate(() => {
    const api = (window as unknown as Record<string, unknown>).__orbitalVerification as
      | { eventLog?: Array<{ event: string; listenerCount?: number }> }
      | undefined;
    return api?.eventLog ?? [];
  });
}

/**
 * Build a RuntimeState from the verification snapshot.
 * Combines trait states, entity data, events, and guard results.
 */
export async function readRuntimeState(page: Page): Promise<RuntimeState | null> {
  const snapshot = await readVerificationSnapshot(page);
  if (!snapshot) return null;

  const traitStates = await readTraitStates(page);

  return {
    traits: Object.fromEntries(
      Object.entries(traitStates).map(([name, currentState]) => [
        name,
        { currentState, context: {} },
      ])
    ),
    entities: {}, // Entity data requires FetchedDataContext inspection
    events: snapshot.transitions.map((t) => t.event),
    guards: Object.fromEntries(
      snapshot.checks
        .filter((c) => c.id.startsWith('guard-'))
        .map((c) => [c.id, c.status === 'pass'])
    ),
  };
}
