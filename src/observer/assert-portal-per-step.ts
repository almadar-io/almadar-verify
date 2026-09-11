/**
 * `assertPortalPerStep` — pure observer over `Frame[]` for VG1 per-step
 * portal slot verification.
 *
 * For each frame whose cause matches a `PortalExpectation` (by
 * traitName + from + event + to) AND that frame is accepted +
 * non-repositioning + non-guard-fail:
 *   - If `pattern !== null`: assert the named slot is mounted with
 *     `childCount > 0`.
 *   - If `pattern === null`: assert the slot is unmounted or empty
 *     (the transition explicitly cleared it).
 *
 * Pre-v3.0.0 this lived inline in orbital's `EngineAdapter.onTransition`
 * as a `probePortalSlots(page, expected)` call after each accepted
 * transition. The lifted shape reads only `frame.domSnapshot.portals`
 * (verify-owned DOM observation, captured once per `tick` settle).
 *
 * Consumers compute `expectations` from their schema (orbital's
 * `portalRendersFromTransition`) and pass via
 * `RunVerificationInput.rules.portal`.
 *
 * @packageDocumentation
 */

import type { Frame } from '../frame/types.js';
import type { PortalExpectation, Verdict } from './types.js';

export function assertPortalPerStep(
  frames: ReadonlyArray<Frame>,
  expectations: ReadonlyArray<PortalExpectation>,
): Verdict[] {
  if (expectations.length === 0) return [];

  const verdicts: Verdict[] = [];

  // Group expectations by (trait, from, event, to) for O(1) per-frame lookup.
  const expectationsByCause = new Map<string, PortalExpectation[]>();
  for (const exp of expectations) {
    const key = `${exp.traitName}:${exp.from}+${exp.event}->${exp.to}`;
    const bucket = expectationsByCause.get(key) ?? [];
    bucket.push(exp);
    expectationsByCause.set(key, bucket);
  }

  for (const frame of frames) {
    if (!frame.accepted) continue;
    if (frame.cause.isRepositioning) continue;
    if (frame.cause.guardCase === 'fail') continue;
    // Malformed-variant frames (planWalk's empty-payload negative-path
    // coverage) intentionally trigger validator rejection — the
    // transition doesn't fire, so render-ui never executes, and portal
    // expectations don't apply.
    if (frame.cause.payloadCase === 'malformed') continue;
    // CRUD-flow frames capture state AFTER the full open→fill→submit→
    // cascade flow, so the modal is already closed by snapshot time
    // even though the planner's expectation matches the OPEN transition.
    const tk = frame.cause.testKind;
    if (tk === 'crud-create' || tk === 'crud-edit' || tk === 'crud-delete') continue;

    // Skip when the runtime didn't actually apply this transition. This
    // happens when the planner injects a probe event whose effects the
    // runtime never executed — e.g. an *LoadFailed event injected
    // against a trait whose mock-store always resolves success, so the
    // cascade reached `loading -> open` (RowLoaded) before the planner's
    // failure-path probe could land. The frame's `cause.to` records what
    // the planner WOULD reach if effects ran; if the live runtime
    // snapshot disagrees, the assertion is checking a DOM that reflects
    // a different state machine state, not the post-transition one the
    // expectation models. Trust the runtime's recorded `currentState`
    // over the planner's projection.
    const traitSnap = frame.runtimeSnapshot.traits.find(
      (t) => t.traitName === frame.cause.traitName,
    );
    if (traitSnap !== undefined && traitSnap.currentState !== frame.cause.to) continue;

    const key = `${frame.cause.traitName}:${frame.cause.from}+${frame.cause.event}->${frame.cause.to}`;
    const matched = expectationsByCause.get(key);
    if (matched === undefined) continue;

    for (const exp of matched) {
      const portal = frame.domSnapshot.portals.find((p) => p.slot === exp.slot);

      if (exp.pattern === null) {
        // Expecting empty/unmounted slot.
        const isEmpty = portal === undefined || !portal.mounted || portal.childCount === 0;
        verdicts.push({
          passed: isEmpty,
          detail: isEmpty
            ? `portal: ${exp.traitName} ${exp.event} cleared slot "${exp.slot}" as expected`
            : `portal: ${exp.traitName} ${exp.event} expected slot "${exp.slot}" to be empty, found mounted with ${portal.childCount} child(ren)`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }

      // Expecting populated slot.
      if (portal === undefined || !portal.mounted) {
        verdicts.push({
          passed: false,
          detail: `portal: ${exp.traitName} ${exp.event} expected pattern "${exp.pattern}" in slot "${exp.slot}", slot not mounted`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }
      if (portal.childCount === 0) {
        verdicts.push({
          passed: false,
          detail: `portal: ${exp.traitName} ${exp.event} expected pattern "${exp.pattern}" in slot "${exp.slot}", slot mounted but empty (blank-portal bug)`,
          evidence: { frameIndices: [frame.index] },
        });
        continue;
      }

      verdicts.push({
        passed: true,
        detail: `portal: ${exp.traitName} ${exp.event} mounted "${exp.pattern}" in slot "${exp.slot}" with ${portal.childCount} child(ren)`,
        evidence: { frameIndices: [frame.index] },
      });
    }
  }

  return verdicts;
}

/**
 * `assertTransientFailureArmPortals` — RV item 27: the portal check for a
 * failure-route arm whose `from` state races forward via an
 * effect-emitted sibling. `planTransientFailureProbes` dispatches the
 * transition that ENTERS `from` under a denying viewer instead of the
 * arm's own (unreachable) `(from, event)`, so the frame's own `cause`
 * never literally matches the expectation — the arm to check is carried
 * on `frame.cause.verifiesPortalFor` instead, and whether it actually
 * fired is read from `frame.runtimeSnapshot.transitions` (the SAME
 * "server cascade credit" the coverage observer already uses), not from
 * `cause`/`accepted`. No match in any frame's snapshot means the forced
 * dispatch did not reproduce the failure — an honest fail, never a false
 * "slot not mounted".
 */
export function assertTransientFailureArmPortals(
  frames: ReadonlyArray<Frame>,
  expectations: ReadonlyArray<PortalExpectation>,
): Verdict[] {
  if (expectations.length === 0) return [];
  const verdicts: Verdict[] = [];

  for (const exp of expectations) {
    const frameIndex = frames.findIndex((f) =>
      f.cause.verifiesPortalFor?.traitName === exp.traitName
      && f.cause.verifiesPortalFor.from === exp.from
      && f.cause.verifiesPortalFor.event === exp.event
      && f.cause.verifiesPortalFor.to === exp.to,
    );
    if (frameIndex === -1) continue; // not a probed arm — nothing to say here

    const label = `${exp.traitName} ${exp.event} (forced-failure probe)`;
    const armFired = frames[frameIndex].runtimeSnapshot.transitions.some(
      (t) => t.traitName === exp.traitName && t.from === exp.from && t.event === exp.event && t.to === exp.to,
    );
    if (!armFired) {
      verdicts.push({
        passed: false,
        detail: `portal: ${label} — the denying viewer did not reproduce the failure; '${exp.from}+${exp.event}->${exp.to}' never fired`,
        evidence: { frameIndices: [frameIndex] },
      });
      continue;
    }

    const portal = frames[frameIndex].domSnapshot.portals.find((p) => p.slot === exp.slot);
    if (exp.pattern === null) {
      const isEmpty = portal === undefined || !portal.mounted || portal.childCount === 0;
      verdicts.push({
        passed: isEmpty,
        detail: isEmpty
          ? `portal: ${label} cleared slot "${exp.slot}" as expected`
          : `portal: ${label} expected slot "${exp.slot}" to be empty, found mounted with ${portal.childCount} child(ren)`,
        evidence: { frameIndices: [frameIndex] },
      });
      continue;
    }
    if (portal === undefined || !portal.mounted) {
      verdicts.push({
        passed: false,
        detail: `portal: ${label} expected pattern "${exp.pattern}" in slot "${exp.slot}", slot not mounted`,
        evidence: { frameIndices: [frameIndex] },
      });
      continue;
    }
    if (portal.childCount === 0) {
      verdicts.push({
        passed: false,
        detail: `portal: ${label} expected pattern "${exp.pattern}" in slot "${exp.slot}", slot mounted but empty (blank-portal bug)`,
        evidence: { frameIndices: [frameIndex] },
      });
      continue;
    }
    verdicts.push({
      passed: true,
      detail: `portal: ${label} mounted "${exp.pattern}" in slot "${exp.slot}" with ${portal.childCount} child(ren)`,
      evidence: { frameIndices: [frameIndex] },
    });
  }

  return verdicts;
}

/**
 * `assertSlotShowsForeignTransitionRender` — the runtime twin of compiler
 * §98's last-writer-per-slot contract. `assertPortalPerStep` only checks
 * "is SOMETHING mounted" (`childCount > 0`); this checks WHICH pattern is
 * mounted, using the DOM's own deterministic `data-pattern` marker
 * (`domSnapshot.portals[*].pattern`, `UISlotRenderer`'s own stamp — no
 * text/label heuristics). Walking frames in dispatch order, tracks each
 * slot's expected content from its last matching `PortalExpectation`; a
 * later frame whose observed pattern equals a DIFFERENT declared writer's
 * own pattern (not the current expected one) means that OTHER
 * transition's render is still showing — a stale/foreign render, not a
 * blank one. An unrecognized observed pattern (matches no declared writer
 * at all) is left silent: not attributable, so not a finding.
 */
export function assertSlotShowsForeignTransitionRender(
  frames: ReadonlyArray<Frame>,
  expectations: ReadonlyArray<PortalExpectation>,
): Verdict[] {
  if (expectations.length === 0) return [];
  const verdicts: Verdict[] = [];

  const expectationsByCause = new Map<string, PortalExpectation[]>();
  const writersBySlot = new Map<string, Map<string, string>>();
  for (const exp of expectations) {
    if (exp.pattern === null) continue;
    const causeKey = `${exp.traitName}:${exp.from}+${exp.event}->${exp.to}`;
    const bucket = expectationsByCause.get(causeKey) ?? [];
    bucket.push(exp);
    expectationsByCause.set(causeKey, bucket);

    const bySlot = writersBySlot.get(exp.slot) ?? new Map<string, string>();
    bySlot.set(exp.pattern, `${exp.traitName}.${exp.event}`);
    writersBySlot.set(exp.slot, bySlot);
  }

  for (const frame of frames) {
    if (!frame.accepted || frame.cause.isRepositioning || frame.cause.guardCase === 'fail') continue;
    if (frame.cause.payloadCase === 'malformed') continue;
    const causeKey = `${frame.cause.traitName}:${frame.cause.from}+${frame.cause.event}->${frame.cause.to}`;
    const matched = expectationsByCause.get(causeKey);
    if (matched === undefined) continue;

    for (const exp of matched) {
      const portal = frame.domSnapshot.portals.find((p) => p.slot === exp.slot);
      if (portal === undefined || !portal.mounted || portal.pattern === undefined) continue;
      if (portal.pattern === exp.pattern) continue;
      const foreignAuthor = writersBySlot.get(exp.slot)?.get(portal.pattern);
      if (foreignAuthor === undefined) continue;
      verdicts.push({
        passed: false,
        detail:
          `slot-shows-foreign-transition-render: ${frame.cause.traitName} ${frame.cause.event} expected ` +
          `'${exp.pattern}' in slot '${exp.slot}', but the DOM shows '${portal.pattern}' — authored by ` +
          `${foreignAuthor}, not the last writer`,
        evidence: { frameIndices: [frame.index] },
      });
    }
  }

  return verdicts;
}
