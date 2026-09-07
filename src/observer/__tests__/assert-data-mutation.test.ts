import { describe, it, expect } from 'vitest';
import type { EffectTrace, EntityRow, VerificationSnapshot } from '@almadar/core';
import { assertDataMutation } from '../assert-data-mutation.js';
import type { Frame, FrameCause, EntityChange } from '../../frame/types.js';

const emptyDom = { url: '', rowsByEntity: {}, portals: [], visibleTextSample: '' };
const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const dataMutationCause = (
  event: string,
  expected?: { entityName: string; delta: number },
): FrameCause => ({
  traitName: 'CartItemAddItem',
  from: 'idle',
  event,
  to: 'idle',
  guardCase: null,
  triggerKind: 'dom',
  isRepositioning: false,
  testKind: 'data-mutation',
  ...(expected !== undefined && { expectedRowDelta: expected }),
});

const otherCause = (event: string): FrameCause => ({
  traitName: 'X',
  from: 'a',
  event,
  to: 'b',
  guardCase: null,
  triggerKind: 'bus',
  isRepositioning: false,
});

function frame(
  index: number,
  cause: FrameCause,
  entityChanges: ReadonlyArray<EntityChange>,
  effectResults: ReadonlyArray<EffectTrace> = [],
): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause,
    stateBefore: cause.from,
    stateAfter: cause.to,
    payload: {},
    eventFired: cause.event,
    runtimeSnapshot: emptySnapshot,
    domSnapshot: emptyDom,
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges,
    effectResults,
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

const persistEffect = (
  entityName: string,
  outcome: NonNullable<EffectTrace['outcome']>,
  extra?: Partial<EffectTrace>,
): EffectTrace => ({
  type: 'persist',
  entityName,
  args: [],
  status: outcome === 'success' ? 'executed' : 'failed',
  outcome,
  ...extra,
});

const createChange = (entityName: string, addedRows: ReadonlyArray<EntityRow>): EntityChange => ({
  entityName,
  before: [],
  after: addedRows,
  added: addedRows,
  removed: [],
  changed: [],
});

const deleteChange = (entityName: string, removedRows: ReadonlyArray<EntityRow>): EntityChange => ({
  entityName,
  before: removedRows,
  after: [],
  added: [],
  removed: removedRows,
  changed: [],
});

describe('assertDataMutation', () => {
  it('returns [] when no frames have testKind: data-mutation', () => {
    const frames: Frame[] = [
      frame(0, otherCause('INIT'), []),
      frame(1, otherCause('GO'), []),
    ];
    expect(assertDataMutation(frames)).toEqual([]);
  });

  it('passes when create test sees +1 added row for the named entity', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
        [createChange('CartItem', [{ id: '1', name: 'Apple' }])],
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[0].detail).toMatch(/delta = \+1 as expected/);
  });

  it('passes when delete test sees -1 row for the named entity', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('CONFIRM_DELETE', { entityName: 'CartItem', delta: -1 }),
        [deleteChange('CartItem', [{ id: '1', name: 'Apple' }])],
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(true);
  });

  it('fails when count delta is wrong', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
        [createChange('CartItem', [])], // expected +1, got 0
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/expected delta \+1, got 0/);
  });

  it('fails when no entity change recorded for the named entity', () => {
    const frames: Frame[] = [
      frame(
        0,
        dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
        [],
      ),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/no entityChange recorded/);
  });

  it('fails when expectedRowDelta is missing on the cause (planner bug)', () => {
    const frames: Frame[] = [
      frame(0, dataMutationCause('SAVE'), [createChange('CartItem', [{ id: '1' }])]),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts[0].passed).toBe(false);
    expect(verdicts[0].detail).toMatch(/no expectedRowDelta on cause — planner bug/);
  });

  it('produces one verdict per data-mutation frame', () => {
    const frames: Frame[] = [
      frame(0, dataMutationCause('A', { entityName: 'X', delta: 1 }), [createChange('X', [{ id: '1' }])]),
      frame(1, dataMutationCause('B', { entityName: 'X', delta: 1 }), [createChange('X', [])]),
      frame(2, dataMutationCause('C', { entityName: 'X', delta: -1 }), [deleteChange('X', [{ id: '1' }])]),
    ];
    const verdicts = assertDataMutation(frames);
    expect(verdicts).toHaveLength(3);
    expect(verdicts[0].passed).toBe(true);
    expect(verdicts[1].passed).toBe(false);
    expect(verdicts[2].passed).toBe(true);
  });

  // C1-V1: the persist effect's own recorded outcome is consulted before
  // the row-delta fallback (only reached when no expectedSuccessEvent is
  // declared on the cause — the emit-cascade check still wins first).
  describe('persist-effect outcome beats the recorded response cascade (expectedSuccessEvent declared)', () => {
    const withSuccessEvent = (event: string, entityName: string): FrameCause => ({
      ...dataMutationCause(event, { entityName, delta: 0 }),
      expectedSuccessEvent: 'HelpArticleViewCounted',
    });
    const withResponse = (f: Frame, emittedEvents: string[]): Frame => ({
      ...f,
      serverResponse: {
        orbitalName: 'HelpCenterOrbital',
        success: true,
        clientEffects: 0,
        dataEntities: {},
        emittedEvents,
        timestamp: 1,
      },
    });

    it('passes on a successful persist whose declared emit is missing from the recorded cascade (std-helpdesk OPEN_ARTICLE)', () => {
      const frames: Frame[] = [
        withResponse(
          frame(0, withSuccessEvent('OPEN_ARTICLE', 'HelpArticle'), [], [persistEffect('HelpArticle', 'success', { action: 'update' })]),
          ['ArticleViewed'],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(true);
      expect(verdicts[0].detail).toMatch(/persist succeeded \(action=update\); declared HelpArticleViewCounted not in the recorded response cascade \[ArticleViewed\]/);
    });

    it('fails on a denied persist even when the declared emit IS in the cascade', () => {
      const frames: Frame[] = [
        withResponse(
          frame(0, withSuccessEvent('OPEN_ARTICLE', 'HelpArticle'), [], [persistEffect('HelpArticle', 'denied', { error: 'no row key' })]),
          ['HelpArticleViewCounted'],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(false);
      expect(verdicts[0].detail).toMatch(/persist denied: no row key/);
    });

    it('with no outcome record, the cascade decides', () => {
      const pass = assertDataMutation([withResponse(frame(0, withSuccessEvent('OPEN_ARTICLE', 'HelpArticle'), []), ['HelpArticleViewCounted'])]);
      expect(pass[0].passed).toBe(true);
      const fail = assertDataMutation([withResponse(frame(0, withSuccessEvent('OPEN_ARTICLE', 'HelpArticle'), []), ['ArticleViewed'])]);
      expect(fail[0].passed).toBe(false);
      expect(fail[0].detail).toMatch(/expected server to emit 'HelpArticleViewCounted' but cascade was \[ArticleViewed\]/);
    });
  });

  describe('persist-effect outcome (no expectedSuccessEvent declared)', () => {
    it('fails unconditionally on a denied persist, even when the row delta looks correct', () => {
      const frames: Frame[] = [
        frame(
          0,
          dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
          [createChange('CartItem', [{ id: '1', name: 'Apple' }])],
          [persistEffect('CartItem', 'denied', { error: 'access denied' })],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(false);
      expect(verdicts[0].detail).toMatch(/persist denied: access denied/);
    });

    it('fails unconditionally on a failed persist, even when the row delta looks correct', () => {
      const frames: Frame[] = [
        frame(
          0,
          dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
          [createChange('CartItem', [{ id: '1', name: 'Apple' }])],
          [persistEffect('CartItem', 'failed', { error: 'backend unavailable' })],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(false);
      expect(verdicts[0].detail).toMatch(/persist failed: backend unavailable/);
    });

    it('passes on a successful persist even when the row delta looks wrong', () => {
      const frames: Frame[] = [
        frame(
          0,
          dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
          [createChange('CartItem', [])], // delta 0 — would fail the row-delta check
          [persistEffect('CartItem', 'success', { action: 'create' })],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(true);
      expect(verdicts[0].detail).toMatch(/persist succeeded \(action=create\)/);
    });

    it('prefers the outcome-bearing server record over the trait\'s outcome-less reconstruction (bridge-mode merge order)', () => {
      // `lastEffectResultsFor` lists the trait's reconstructed traces first
      // (`status: 'executed'`, no outcome) and the synthetic `server:<orbital>`
      // traces after — the real outcome must win, not the first match.
      const reconstructed: EffectTrace = {
        type: 'persist',
        entityName: 'CartItem',
        args: ['update', 'CartItem', '@entity'],
        status: 'executed',
      };
      const frames: Frame[] = [
        frame(
          0,
          dataMutationCause('SAVE', { entityName: 'CartItem', delta: 0 }),
          [],
          [reconstructed, persistEffect('CartItem', 'denied', { action: 'update', error: 'resolved no row key' })],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(false);
      expect(verdicts[0].detail).toMatch(/persist denied: resolved no row key/);
    });

    it('falls back to row-delta when no persist effect record names the entity', () => {
      const frames: Frame[] = [
        frame(
          0,
          dataMutationCause('SAVE', { entityName: 'CartItem', delta: 1 }),
          [createChange('CartItem', [{ id: '1' }])],
          [persistEffect('OtherEntity', 'success')],
        ),
      ];
      const verdicts = assertDataMutation(frames);
      expect(verdicts[0].passed).toBe(true);
      expect(verdicts[0].detail).toMatch(/delta = \+1 as expected/);
    });
  });
});
