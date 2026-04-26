/**
 * `observer/` — pure consumers of the temporal frame stream.
 *
 * Every observer takes `ReadonlyArray<Frame>` (or one Frame + previous)
 * and returns a typed verdict, metric, or report. None touch a
 * Playwright `Page` or the runtime; everything they need is precomputed
 * by `tick()` into the Frame stream.
 *
 * @packageDocumentation
 */

export type {
  Observer,
  CoverageMetric,
  BindingDelta,
  BindingMatch,
  CascadeRule,
  MutationRule,
  FieldContentCheck,
  EntityRowContentVerdict,
  Verdict,
  ReportShape,
} from './types.js';

export { coverage } from './coverage.js';
export { assertMutation } from './assert-mutation.js';
export { assertCascade } from './assert-cascade.js';
export { assertPortalSlots } from './assert-portal.js';
export { probeBindings } from './probe-bindings.js';
export { assertRefTraitInvariantOverFrames } from './assert-ref-trait-invariant.js';
export { report, type ReportInput } from './report.js';
