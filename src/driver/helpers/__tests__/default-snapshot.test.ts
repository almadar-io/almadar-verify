/**
 * `lastEffectResultsFor` — the effect-results reader `createDefaultSnapshot`
 * hands into `Frame.effectResults`, which `assertDataMutation` (C1-V1)
 * consults for the persist's real outcome before falling back to the
 * row-delta heuristic.
 *
 * This fixture is shaped like Project Friday's `PersonDirectory.INVITE`
 * transition (`packages/almadar-behaviors/.../project-friday.lolo`):
 * `(set @entity.id ?id) (set @entity.name ?name) (set @entity.email ?email)
 * (set @entity.role ?role) (persist create Person @entity) (emit
 * PERSON_INVITED {...})` — a persist with NO inline `emit:{success}` config
 * (`PERSON_INVITED` is a separate literal `emit` effect), so
 * `assertDataMutation` has no `expectedSuccessEvent` to fall back on and
 * depends entirely on the persist effect's own recorded outcome (C1-V7:
 * `useTraitStateMachine`'s `overlayServerEffectResults` is what makes that
 * outcome real instead of the reconstructed `status: 'executed'`).
 *
 * @packageDocumentation
 */
import { describe, it, expect } from 'vitest';
import type { EffectTrace, ServerResponseTrace, TransitionTrace, VerificationSnapshot } from '@almadar/core';
import { lastEffectResultsFor, lastServerResponseFor } from '../default-snapshot.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

/** The four `(set @entity.<f> ?<f>)` effects INVITE declares before its persist. */
function inviteSetTraces(): EffectTrace[] {
  return ['id', 'name', 'email', 'role'].map((field) => ({
    type: 'set',
    args: [`@entity.${field}`, `?${field}`],
    status: 'executed' as const,
  }));
}

function personDirectoryTransition(effects: EffectTrace[]): TransitionTrace {
  return {
    id: 't-invite-1',
    traitName: 'PersonDirectory',
    from: 'active',
    to: 'active',
    event: 'INVITE',
    effects,
    timestamp: 1000,
  };
}

describe('lastEffectResultsFor — PF PersonDirectory.INVITE frame shape', () => {
  it('a successful invite: the persist trace carries action/resultId/outcome, sets stay reconstructed', () => {
    const persistTrace: EffectTrace = {
      type: 'persist',
      entityName: 'Person',
      action: 'create',
      resultId: 'person_7',
      outcome: 'success',
      args: ['create', 'Person', {}],
      status: 'executed',
    };
    const emitTrace: EffectTrace = {
      type: 'emit',
      args: ['PERSON_INVITED', { personId: 'person_7', role: 'team_member' }],
      status: 'executed',
    };
    const snap: VerificationSnapshot = {
      ...emptySnapshot,
      transitions: [personDirectoryTransition([...inviteSetTraces(), persistTrace, emitTrace])],
    };

    const results = lastEffectResultsFor(snap, 'PersonDirectory', 'INVITE');

    const persist = results.find((e) => e.type === 'persist' && e.entityName === 'Person');
    expect(persist).toBeDefined();
    expect(persist?.outcome).toBe('success');
    expect(persist?.action).toBe('create');
    expect(persist?.resultId).toBe('person_7');
    // The four `set` effects are untouched — overlaying the persist result
    // must not bleed action/resultId/outcome onto sibling effect types.
    expect(results.filter((e) => e.type === 'set')).toHaveLength(4);
    for (const set of results.filter((e) => e.type === 'set')) {
      expect(set.outcome).toBeUndefined();
    }
  });

  it('a denied invite (e.g. access policy rejected the create): the persist trace reports outcome:"denied"', () => {
    const persistTrace: EffectTrace = {
      type: 'persist',
      entityName: 'Person',
      action: 'create',
      outcome: 'denied',
      error: 'persist create Person was denied or failed',
      args: ['create', 'Person', {}],
      status: 'failed',
    };
    const snap: VerificationSnapshot = {
      ...emptySnapshot,
      transitions: [personDirectoryTransition([...inviteSetTraces(), persistTrace])],
    };

    const results = lastEffectResultsFor(snap, 'PersonDirectory', 'INVITE');

    const persist = results.find((e) => e.type === 'persist' && e.entityName === 'Person');
    expect(persist?.outcome).toBe('denied');
    expect(persist?.status).toBe('failed');
  });

  it('picks the most RECENT PersonDirectory transition when the trait fired twice (INVITE then CHANGE_ROLE)', () => {
    const inviteTx = personDirectoryTransition([
      ...inviteSetTraces(),
      { type: 'persist', entityName: 'Person', action: 'create', outcome: 'success', args: [], status: 'executed' },
    ]);
    const changeRoleTx: TransitionTrace = {
      id: 't-change-role-1',
      traitName: 'PersonDirectory',
      from: 'active',
      to: 'active',
      event: 'CHANGE_ROLE',
      effects: [
        { type: 'set', args: ['@entity.role', '?role'], status: 'executed' },
        { type: 'persist', entityName: 'Person', action: 'update', outcome: 'success', args: [], status: 'executed' },
      ],
      timestamp: 2000,
    };
    const snap: VerificationSnapshot = { ...emptySnapshot, transitions: [inviteTx, changeRoleTx] };

    const results = lastEffectResultsFor(snap, 'PersonDirectory', 'CHANGE_ROLE');

    const persist = results.find((e) => e.type === 'persist');
    expect(persist?.action).toBe('update');
  });
});

describe('lastServerResponseFor — std-helpdesk HelpArticleBrowse.OPEN_ARTICLE frame shape', () => {
  const response = (orbitalName: string, emittedEvents: string[]): ServerResponseTrace => ({
    orbitalName,
    success: true,
    clientEffects: 0,
    dataEntities: {},
    emittedEvents,
    timestamp: 1000,
  });
  const transition = (traitName: string, serverResponse: ServerResponseTrace): TransitionTrace => ({
    id: `t-${traitName}`,
    traitName,
    from: 'browsing',
    to: 'viewing_single',
    event: 'OPEN_ARTICLE',
    effects: [],
    timestamp: 1000,
    serverResponse,
  });

  it('unions the client-side trait capture with the server bridge cascade (the persist emit.success only reaches the bridge entry)', () => {
    const snap: VerificationSnapshot = {
      ...emptySnapshot,
      transitions: [
        transition('HelpArticleBrowse', response('', ['ArticleViewed'])),
        transition('server:HelpCenterOrbital', response('HelpCenterOrbital', ['ArticleViewed', 'HelpArticleViewCounted'])),
      ],
    };
    const trace = lastServerResponseFor(snap, 'HelpArticleBrowse', 'OPEN_ARTICLE');
    expect(trace?.orbitalName).toBe('HelpCenterOrbital');
    expect(trace?.emittedEvents).toEqual(['ArticleViewed', 'HelpArticleViewCounted']);
  });

  it('returns whichever entry exists when only one does', () => {
    const clientOnly: VerificationSnapshot = { ...emptySnapshot, transitions: [transition('HelpArticleBrowse', response('', ['ArticleViewed']))] };
    expect(lastServerResponseFor(clientOnly, 'HelpArticleBrowse', 'OPEN_ARTICLE')?.emittedEvents).toEqual(['ArticleViewed']);
    const serverOnly: VerificationSnapshot = { ...emptySnapshot, transitions: [transition('server:HelpCenterOrbital', response('HelpCenterOrbital', ['HelpArticleViewCounted']))] };
    expect(lastServerResponseFor(serverOnly, 'HelpArticleBrowse', 'OPEN_ARTICLE')?.emittedEvents).toEqual(['HelpArticleViewCounted']);
    expect(lastServerResponseFor(emptySnapshot, 'HelpArticleBrowse', 'OPEN_ARTICLE')).toBeNull();
  });
});
