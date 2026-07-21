import { describe, it, expect } from 'vitest';
import type { OrbitalSchema } from '@almadar/core';
import { auditListens } from '../click-wiring-audit.js';

describe('auditListens', () => {
  it('wires a declared emit picked up by a listens block', () => {
    const orbital = {
      orbitals: [
        {
          traits: [
            {
              name: 'Browse',
              stateMachine: { transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing' }] },
              emits: [{ event: 'REQUEST_DELETE', scope: 'internal' }],
            },
            {
              name: 'Delete',
              stateMachine: { transitions: [{ from: 'idle', event: 'DELETE', to: 'confirming' }] },
              listens: [{ event: 'REQUEST_DELETE', triggers: 'DELETE', source: { kind: 'trait', trait: 'Browse' } }],
            },
          ],
        },
      ],
    } as unknown as OrbitalSchema;

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.emitters).toEqual([
      { trait: 'Browse', event: 'REQUEST_DELETE', wired: true, via: 'listens' },
    ]);
  });

  it('wires a declared emit the emitting trait handles itself (self-transition)', () => {
    const orbital = {
      orbitals: [
        {
          traits: [
            {
              name: 'Timer',
              stateMachine: { transitions: [{ from: 'running', event: 'PAUSE', to: 'paused' }] },
              emits: [{ event: 'PAUSE', scope: 'internal' }],
            },
          ],
        },
      ],
    } as unknown as OrbitalSchema;

    const result = auditListens(orbital);
    expect(result.missing).toEqual([]);
    expect(result.emitters).toEqual([
      { trait: 'Timer', event: 'PAUSE', wired: true, via: 'self-transition' },
    ]);
  });

  it('flags a declared emit with no self-transition and no listener, suggesting the listens fix', () => {
    const orbital = {
      orbitals: [
        {
          traits: [
            {
              name: 'Browse',
              stateMachine: { transitions: [{ from: 'browsing', event: 'INIT', to: 'browsing' }] },
              emits: [{ event: 'ORPHAN_EVENT', scope: 'internal' }],
            },
          ],
        },
      ],
    } as unknown as OrbitalSchema;

    const result = auditListens(orbital);
    expect(result.emitters).toEqual([
      { trait: 'Browse', event: 'ORPHAN_EVENT', wired: false, via: null },
    ]);
    expect(result.missing).toEqual([
      { trait: 'Browse', event: 'ORPHAN_EVENT', suggestion: 'listens { Browse.ORPHAN_EVENT -> ORPHAN_EVENT }' },
    ]);
  });

  it('excludes fetch/persist success|failure auto-emits (never button-ish)', () => {
    const orbital = {
      orbitals: [
        {
          traits: [
            {
              name: 'Circuit',
              stateMachine: {
                transitions: [
                  {
                    from: 'closed',
                    event: 'INIT',
                    to: 'closed',
                    effects: [['fetch', 'Node', { emit: { success: 'NodeLoaded', failure: 'NodeLoadFailed' } }]],
                  },
                ],
              },
              emits: [
                { event: 'NodeLoaded', scope: 'internal' },
                { event: 'NodeLoadFailed', scope: 'internal' },
              ],
            },
          ],
        },
      ],
    } as unknown as OrbitalSchema;

    const result = auditListens(orbital);
    expect(result.emitters).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});
