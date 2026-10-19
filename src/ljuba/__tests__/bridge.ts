import type { EventPayload, OrbitalVerificationAPI, TraitStateSnapshot, VerificationSnapshot } from '@almadar/core';

export const traitSnapshot = (traitName: string, currentState: string): TraitStateSnapshot => ({ traitName, currentState, states: [currentState], events: [], data: {}, cascadeReceived: [] });

export interface SentEvent { event: string; payload: EventPayload | undefined; traitScope: string | undefined }

const SUMMARY = { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 };

/** A `window.__orbitalVerification` over these traits; `sent` records `sendEvent` calls, and without it the bridge has no `sendEvent`. */
export function verificationBridge(traits: TraitStateSnapshot[], sent?: SentEvent[]): OrbitalVerificationAPI {
  const snapshot = (): VerificationSnapshot => ({ checks: [], transitions: [], bridge: null, summary: SUMMARY, traits });
  return {
    getSnapshot: snapshot,
    getChecks: () => [],
    getTransitions: () => [],
    getBridge: () => null,
    getSummary: () => SUMMARY,
    waitForTransition: async () => null,
    ...(sent !== undefined ? { sendEvent: (event: string, payload?: EventPayload, traitScope?: string) => { sent.push({ event, payload, traitScope }); } } : {}),
  };
}
