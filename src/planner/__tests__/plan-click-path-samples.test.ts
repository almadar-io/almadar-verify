import { describe, it, expect } from 'vitest';
import { planClickPathSamples, type RenderSiteSpec } from '../plan-click-path-samples.js';
import type { TraitWalkConfig } from '../../engine/types.js';

const trait: TraitWalkConfig = {
  traitName: 'CartItemBrowse',
  initialState: 'browsing',
  transitions: [],
};

describe('planClickPathSamples', () => {
  it('emits one dom step per render site, tagged click-path', () => {
    const sites: RenderSiteSpec[] = [
      { traitName: 'CartItemBrowse', siteKey: 'main:button:ADD_ITEM', event: 'ADD_ITEM', slot: 'main', patternType: 'button' },
      { traitName: 'CartItemBrowse', siteKey: 'main:row:REMOVE_ITEM', event: 'REMOVE_ITEM', slot: 'main', patternType: 'data-grid' },
    ];

    const steps = planClickPathSamples({ traits: [trait], renderSites: sites });

    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.triggerKind).toBe('dom');
      expect(step.testKind).toBe('click-path');
      expect(step.from).toBe('browsing');
      expect(step.to).toBe('browsing');
      expect(step.coverageKey).toMatch(/\[click-path:main:/);
    }
    expect(steps.map((s) => s.event).sort()).toEqual(['ADD_ITEM', 'REMOVE_ITEM']);
  });

  it('skips sites whose trait is not in the traits list (background traits)', () => {
    const sites: RenderSiteSpec[] = [
      { traitName: 'CartItemBrowse', siteKey: 'main:btn:GO', event: 'GO', slot: 'main', patternType: 'button' },
      { traitName: 'GhostTrait', siteKey: 'main:btn:GO', event: 'GO', slot: 'main', patternType: 'button' },
    ];

    const steps = planClickPathSamples({ traits: [trait], renderSites: sites });
    expect(steps).toHaveLength(1);
    expect(steps[0].traitName).toBe('CartItemBrowse');
  });

  it('embeds the siteKey in the coverage key so per-site samples have distinct keys', () => {
    const sites: RenderSiteSpec[] = [
      { traitName: 'CartItemBrowse', siteKey: 'main:hdr:SAVE', event: 'SAVE', slot: 'main', patternType: 'button' },
      { traitName: 'CartItemBrowse', siteKey: 'main:row:SAVE', event: 'SAVE', slot: 'main', patternType: 'data-grid' },
    ];

    const steps = planClickPathSamples({ traits: [trait], renderSites: sites });
    expect(steps).toHaveLength(2);
    expect(steps[0].coverageKey).not.toBe(steps[1].coverageKey);
  });

  it('returns [] for the empty render-site list', () => {
    expect(planClickPathSamples({ traits: [trait], renderSites: [] })).toHaveLength(0);
  });
});
