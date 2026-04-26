import { describe, it, expect } from 'vitest';
import { decorateWithTriggerKind } from '../plan-dom-decoration.js';
import type { ExtendedWalkStep } from '../types.js';

function step(event: string, triggerKind: ExtendedWalkStep['triggerKind']): ExtendedWalkStep {
  return {
    from: 'a',
    event,
    to: 'b',
    guardCase: null,
    payload: {},
    isRepositioning: triggerKind === 'replay',
    traitName: 'X',
    triggerKind,
    coverageKey: `X:a+${event}->b`,
  };
}

describe('decorateWithTriggerKind', () => {
  it('flips bus → dom for events in the dom set', () => {
    const steps = [step('OPEN', 'bus'), step('CLOSE', 'bus')];
    const out = decorateWithTriggerKind({
      steps,
      domEvents: new Set(['OPEN']),
    });
    expect(out[0].triggerKind).toBe('dom');
    expect(out[1].triggerKind).toBe('bus');
  });

  it('leaves auto-init steps untouched even if their event is in the dom set', () => {
    const steps = [step('INIT', 'auto-init')];
    const out = decorateWithTriggerKind({
      steps,
      domEvents: new Set(['INIT']),
    });
    expect(out[0].triggerKind).toBe('auto-init');
  });

  it('leaves replay steps untouched even if their event is in the dom set', () => {
    const steps = [step('GO', 'replay')];
    const out = decorateWithTriggerKind({
      steps,
      domEvents: new Set(['GO']),
    });
    expect(out[0].triggerKind).toBe('replay');
  });

  it('returns a new array (does not mutate)', () => {
    const original = [step('X', 'bus')];
    const out = decorateWithTriggerKind({
      steps: original,
      domEvents: new Set(['X']),
    });
    expect(original[0].triggerKind).toBe('bus');
    expect(out[0].triggerKind).toBe('dom');
  });
});
