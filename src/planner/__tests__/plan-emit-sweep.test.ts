import { describe, it, expect } from 'vitest';
import { planEmitSweep } from '../plan-emit-sweep.js';
import type { TraitWalkConfig } from '../../engine/types.js';
import type { EmitDeclaration } from '../../browser/catalog-probes.js';

const trait: TraitWalkConfig = {
  traitName: 'BrowseItemBrowse',
  initialState: 'loading',
  transitions: [],
};

describe('planEmitSweep', () => {
  it('emits one bus step per declared success event', () => {
    const emits: EmitDeclaration[] = [
      { success: 'BrowseItemLoaded' },
      { success: 'OtherEvent' },
    ];
    const steps = planEmitSweep({ trait, emits });
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.triggerKind).toBe('bus');
      expect(step.from).toBe('loading');
      expect(step.to).toBe('loading');
      expect(step.coverageKey).toMatch(/\[emit\]$/);
    }
    const events = steps.map((s) => s.event).sort();
    expect(events).toEqual(['BrowseItemLoaded', 'OtherEvent']);
  });

  it('emits one step for each of success and failure when both are declared', () => {
    const emits: EmitDeclaration[] = [
      { success: 'BrowseItemLoaded', failure: 'BrowseItemLoadFailed' },
    ];
    const steps = planEmitSweep({ trait, emits });
    expect(steps).toHaveLength(2);
    const events = steps.map((s) => s.event).sort();
    expect(events).toEqual(['BrowseItemLoadFailed', 'BrowseItemLoaded']);
  });

  it('deduplicates repeated event names across declarations', () => {
    const emits: EmitDeclaration[] = [
      { success: 'X' },
      { success: 'X' },
      { failure: 'X' },
    ];
    const steps = planEmitSweep({ trait, emits });
    expect(steps).toHaveLength(1);
    expect(steps[0].event).toBe('X');
  });

  it('returns [] for an empty emits list', () => {
    expect(planEmitSweep({ trait, emits: [] })).toHaveLength(0);
  });

  it('uses [emit]-suffixed coverage keys to distinguish from topology coverage', () => {
    const emits: EmitDeclaration[] = [{ success: 'PingEvent' }];
    const [step] = planEmitSweep({ trait, emits });
    expect(step.coverageKey).toBe(
      'BrowseItemBrowse:loading+PingEvent->loading[emit]',
    );
  });
});
