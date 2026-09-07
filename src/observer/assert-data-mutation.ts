/**
 * `assertDataMutation` — pure observer over `Frame[]` for Phase 4b+
 * data mutation verification.
 *
 * For each frame whose `cause.testKind === 'data-mutation'`:
 *   - Read `cause.expectedRowDelta` (the entityName + signed delta the
 *     planner attached).
 *   - Look up the matching `EntityChange` in `frame.entityChanges`.
 *   - Verify `change.added.length - change.removed.length === expected.delta`.
 *
 * Pre-v3.0.0 this lived in orbital `phase4-browser.ts:3357-3655` as a
 * loop that navigated to each test's route, replayed paths, clicked
 * affordances, and inspected `countEntityRows(page)` deltas
 * imperatively. The lifted shape reads only the temporal Frame stream
 * — `frame.entityChanges` is the canonical core-typed diff
 * (`EntityRow[]` before/after with `added`/`removed`/`changed` arrays
 * computed by `frame/factory.diffEntities`).
 *
 * Sibling observer `assertMutation` (which takes a `MutationRule`)
 * covers the same semantics for callers that pass rules directly to
 * `runVerification`. This observer covers the planner-extension
 * pathway: `planDataMutationTests` produces the steps, this observer
 * produces the verdicts.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { Verdict } from './types.js';

export function assertDataMutation(frames: ReadonlyArray<Frame>): Verdict[] {
  const verdicts: Verdict[] = [];

  for (const frame of frames) {
    if (frame.cause.testKind !== 'data-mutation') continue;

    const expected = frame.cause.expectedRowDelta;
    if (expected === undefined) {
      verdicts.push({
        passed: false,
        detail: `data-mutation: frame ${frame.index} (${frame.cause.event}) has no expectedRowDelta on cause — planner bug`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    const successEvent = frame.cause.expectedSuccessEvent;
    const emittedOnServer = frame.serverResponse?.emittedEvents ?? [];
    const change = frame.entityChanges.find((c) => c.entityName === expected.entityName);
    const actualDelta = change !== undefined
      ? change.added.length - change.removed.length
      : 0;
    const deltaMatches = change !== undefined && actualDelta === expected.delta;
    const deltaDetail = change !== undefined
      ? `delta=${signDelta(actualDelta)} (added=${change.added.length}, removed=${change.removed.length})`
      : `no entityChange recorded for ${expected.entityName}`;

    // C1-V1 (owner ruling: the persist OUTCOME is surfaced unconditionally):
    // the first signal is the persist effect's OWN recorded outcome for
    // this entity — what the runtime set at the write (denied by policy,
    // failed, or succeeded), never inferred from a row count or from the
    // response cascade. A denied/failed write fails even when the row
    // count or the cascade happens to look right; a success passes even
    // when the declared `emit.success` is missing from the RECORDED
    // response — the executor fires that emit synchronously after the
    // store returns, but the bridge records the response before a
    // cross-orbital fan-out of that emit settles (std-helpdesk
    // `OPEN_ARTICLE`: `persist:success` + `HelpArticleViewCounted` in the
    // server log, cascade `[ArticleViewed]` in the frame, 2026-09-07).
    // `lastEffectResultsFor` merges the trait's own traces (a structural
    // reconstruction from the declared SExprs — no outcome) AHEAD of the
    // synthetic `server:<orbital>` entry that carries the real outcome, so
    // prefer the record that actually carries one.
    const persistRecords = frame.effectResults.filter(
      (e) => e.type === 'persist' && e.entityName === expected.entityName,
    );
    const persistRecord = persistRecords.find((e) => e.outcome !== undefined) ?? persistRecords[0];
    if (persistRecord?.outcome === 'denied' || persistRecord?.outcome === 'failed') {
      verdicts.push({
        passed: false,
        detail: `data-mutation: ${frame.cause.event} on ${expected.entityName} persist ${persistRecord.outcome}`
          + `${persistRecord.error ? `: ${persistRecord.error}` : ''} (${deltaDetail})`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }
    if (persistRecord?.outcome === 'success') {
      const emitNote = successEvent === undefined
        ? ''
        : emittedOnServer.includes(successEvent)
          ? `; server emitted ${successEvent}`
          : `; declared ${successEvent} not in the recorded response cascade [${emittedOnServer.join(', ')}]`;
      verdicts.push({
        passed: true,
        detail: `data-mutation: ${frame.cause.event} on ${expected.entityName} persist succeeded`
          + `${persistRecord.action ? ` (action=${persistRecord.action})` : ''}${emitNote} (${deltaDetail})`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }

    // No outcome record reached the frame: the persist effect's declared
    // `emit.success` landing in the server's emittedEvents cascade is the
    // next signal (the persist effect REQUIRES emit.success at the schema
    // level — canonical-operators.json `requiresEmitSuccess: true`).
    if (successEvent !== undefined) {
      const emitFired = emittedOnServer.includes(successEvent);
      if (emitFired) {
        verdicts.push({
          passed: true,
          detail: `data-mutation: ${frame.cause.event} on ${expected.entityName} server emitted ${successEvent} (${deltaDetail})`,
          evidence: { frameIndices: [frame.index] },
        });
      } else {
        verdicts.push({
          passed: false,
          detail: `data-mutation: ${frame.cause.event} on ${expected.entityName} expected server to emit '${successEvent}' but cascade was [${emittedOnServer.join(', ')}] (${deltaDetail})`,
          evidence: { frameIndices: [frame.index] },
        });
      }
      continue;
    }

    // Fallback: no persist outcome record and no expectedSuccessEvent
    // declared — use the legacy row-delta check.
    if (change === undefined) {
      verdicts.push({
        passed: false,
        detail: `data-mutation: ${frame.cause.event} expected ${expected.entityName} delta ${signDelta(expected.delta)}, but no entityChange recorded`,
        evidence: { frameIndices: [frame.index] },
      });
      continue;
    }
    verdicts.push({
      passed: deltaMatches,
      detail: deltaMatches
        ? `data-mutation: ${frame.cause.event} on ${expected.entityName} delta = ${signDelta(actualDelta)} as expected (no expectedSuccessEvent declared — schema needs emit.success)`
        : `data-mutation: ${frame.cause.event} on ${expected.entityName} expected delta ${signDelta(expected.delta)}, got ${signDelta(actualDelta)} (and no expectedSuccessEvent to fall back on)`,
      evidence: { frameIndices: [frame.index] },
    });
  }

  return verdicts;
}

function signDelta(d: number): string {
  if (d > 0) return `+${d}`;
  if (d < 0) return `${d}`;
  return '0';
}
