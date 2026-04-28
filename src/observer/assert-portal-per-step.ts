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
