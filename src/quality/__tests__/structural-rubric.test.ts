import { describe, it, expect } from 'vitest';
import { parseOrbitalSchema, type OrbitalSchema } from '@almadar/core';
import { scoreStructuralQuality } from '../structural-rubric.js';

/**
 * A rich, std-flashcards-like orbital: a deep (≥4) render tree mixing atoms
 * (stack/typography/button/icon), a molecule (data-grid), and an organism
 * (entity-table); two layout axes; a static children array, a `renderItem`
 * lambda and an FC-5 `array/map` child; tiered config knobs (domain +
 * presentation); and a guarded state machine.
 */
function richSchema(): OrbitalSchema {
  return parseOrbitalSchema({
    name: 'Rich',
    orbitals: [
      {
        name: 'Deck',
        entity: { name: 'Card', fields: [{ name: 'id', type: 'string' }] },
        pages: [],
        traits: [
          {
            name: 'deck',
            scope: 'collection',
            config: {
              title: { type: 'string', default: 'Deck', tier: 'presentation', label: 'Title' },
              deckId: { type: 'string', tier: 'domain', label: 'Deck' },
              gap: { type: 'string', default: 'md', tier: 'presentation' },
            },
            stateMachine: {
              states: [
                { name: 'loading', isInitial: true },
                { name: 'browsing' },
                { name: 'flipping' },
                { name: 'adding' },
                { name: 'error' },
              ],
              events: [],
              transitions: [
                {
                  from: 'loading',
                  to: 'browsing',
                  event: 'LOADED',
                  effects: [
                    [
                      'render-ui',
                      'main',
                      {
                        type: 'stack',
                        direction: 'vertical',
                        gap: 'md',
                        align: 'center',
                        children: [
                          {
                            type: 'stack',
                            direction: 'horizontal',
                            justify: 'between',
                            align: 'center',
                            children: [
                              { type: 'icon', name: 'activity' },
                              { type: 'typography', variant: 'h3', content: '@config.title' },
                              { type: 'button', variant: 'primary', label: 'Add', action: 'ADD' },
                            ],
                          },
                          { type: 'divider' },
                          {
                            type: 'entity-table',
                            entity: '@payload.data',
                            children: [
                              {
                                type: 'stack',
                                direction: 'vertical',
                                children: [{ type: 'typography', content: '@item.front' }],
                              },
                            ],
                            renderItem: {
                              type: 'stack',
                              children: [{ type: 'badge', content: '@item.tag' }],
                            },
                          },
                          {
                            type: 'data-grid',
                            children: [
                              [
                                'array/map',
                                '@entity.cards',
                                ['fn', 'item', { type: 'card', children: [{ type: 'typography', content: '@item.back' }] }],
                              ],
                            ],
                          },
                        ],
                      },
                    ],
                  ],
                },
                {
                  from: 'browsing',
                  to: 'flipping',
                  event: 'FLIP',
                  guard: ['>', '@entity.count', 0],
                  effects: [],
                },
                {
                  from: 'browsing',
                  to: 'adding',
                  event: 'ADD',
                  guard: ['=', '@entity.locked', false],
                  effects: [],
                },
                {
                  from: 'adding',
                  to: 'error',
                  event: 'FAIL',
                  guard: ['not', '@entity.ok'],
                  effects: [],
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

/** A flat single-pattern dump: one shallow render tree, no collections, no tiered knobs, trivial machine. */
function flatSchema(): OrbitalSchema {
  return parseOrbitalSchema({
    name: 'Flat',
    orbitals: [
      {
        name: 'Plain',
        entity: { name: 'Thing', fields: [{ name: 'id', type: 'string' }] },
        pages: [],
        traits: [
          {
            name: 'plain',
            scope: 'instance',
            stateMachine: {
              states: [{ name: 'idle', isInitial: true }],
              events: [],
              transitions: [
                {
                  from: 'idle',
                  to: 'idle',
                  event: 'INIT',
                  effects: [['render-ui', 'main', { type: 'typography', content: 'Hello' }]],
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe('scoreStructuralQuality', () => {
  it('scores a rich composed tree high on the relevant subscores', () => {
    const report = scoreStructuralQuality(richSchema());
    const s = report.subscores;

    expect(s.nestingDepth).toBeGreaterThan(0.6);
    expect(s.patternDiversity).toBeGreaterThan(0.6);
    expect(s.tierMix).toBe(1); // atoms + molecules + organisms all present
    expect(s.collectionRendering).toBeGreaterThan(0.6);
    expect(s.layoutIntent).toBeGreaterThan(0.6);
    expect(s.interactionDepth).toBeGreaterThan(0.6);
    expect(s.domainKnobRatio).toBeGreaterThan(0); // 1 domain of 3 tiered knobs

    const deck = report.orbitals.Deck;
    expect(deck.maxNestingDepth).toBeGreaterThanOrEqual(4);
    expect(deck.tierMix.atoms).toBeGreaterThan(0);
    expect(deck.tierMix.molecules).toBeGreaterThan(0);
    expect(deck.tierMix.organisms).toBeGreaterThan(0);
    expect(deck.collection.mapChildren).toBe(1);
    expect(deck.collection.renderItemLambdas).toBe(1);
    expect(deck.layout.axes.sort()).toEqual(['horizontal', 'vertical']);
    expect(deck.knobTiers.domain).toBe(1);
    expect(deck.knobTiers.presentation).toBe(2);
    expect(deck.interaction.guardedTransitions).toBe(3);
    expect(report.aggregate.knobTierMetadataPresent).toBe(true);
  });

  it('scores a flat single-pattern dump low', () => {
    const report = scoreStructuralQuality(flatSchema());
    const s = report.subscores;

    expect(s.nestingDepth).toBe(0); // depth 1 → 0
    expect(s.patternDiversity).toBe(0); // 1 distinct type → 0
    expect(s.tierMix).toBe(0); // single tier → 0
    expect(s.collectionRendering).toBe(0);
    expect(s.layoutIntent).toBe(0);
    expect(s.domainKnobRatio).toBe(0);

    expect(report.orbitals.Plain.maxNestingDepth).toBe(1);
    expect(report.aggregate.knobTierMetadataPresent).toBe(false);
  });

  it('separates rich from flat on the composite structural signals', () => {
    const rich = scoreStructuralQuality(richSchema()).subscores;
    const flat = scoreStructuralQuality(flatSchema()).subscores;
    for (const key of ['nestingDepth', 'patternDiversity', 'tierMix', 'collectionRendering', 'layoutIntent']) {
      expect(rich[key]).toBeGreaterThan(flat[key]);
    }
  });

  it('is safe on empty / missing children and empty orbital list', () => {
    const empty = parseOrbitalSchema({
      name: 'Empty',
      orbitals: [
        {
          name: 'Void',
          entity: { name: 'E', fields: [{ name: 'id', type: 'string' }] },
          pages: [],
          traits: [
            {
              name: 'void',
              scope: 'instance',
              stateMachine: {
                states: [{ name: 'a', isInitial: true }],
                events: [],
                transitions: [
                  { from: 'a', to: 'a', event: 'X', effects: [['render-ui', 'main', { type: 'stack', children: [] }]] },
                  { from: 'a', to: 'a', event: 'Y', effects: [['render-ui', 'main', null]] },
                ],
              },
            },
          ],
        },
      ],
    });
    const report = scoreStructuralQuality(empty);
    expect(report.orbitals.Void.maxNestingDepth).toBe(1);
    expect(report.orbitals.Void.collection.childrenArrays).toBe(0); // empty children array not counted
    expect(Number.isFinite(report.subscores.nestingDepth)).toBe(true);
  });

  it('counts unknown pattern tokens separately without erroring', () => {
    const schema = parseOrbitalSchema({
      name: 'Unknown',
      orbitals: [
        {
          name: 'U',
          entity: { name: 'E', fields: [{ name: 'id', type: 'string' }] },
          pages: [],
          traits: [
            {
              name: 'u',
              scope: 'instance',
              stateMachine: {
                states: [{ name: 'a', isInitial: true }],
                events: [],
                transitions: [
                  {
                    from: 'a',
                    to: 'a',
                    event: 'X',
                    effects: [
                      [
                        'render-ui',
                        'main',
                        {
                          type: 'stack',
                          children: [
                            { type: 'totally-not-a-real-pattern' },
                            { type: '@config.dynamicType' }, // @-bound → skipped
                          ],
                        },
                      ],
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const report = scoreStructuralQuality(schema);
    const u = report.orbitals.U;
    expect(u.tierMix.unknown).toBe(1); // the fake token
    expect(u.tierMix.atoms).toBe(1); // stack
    expect(u.distinctPatternTypes).toContain('totally-not-a-real-pattern');
    expect(u.distinctPatternTypes).not.toContain('@config.dynamicType');
  });
});
