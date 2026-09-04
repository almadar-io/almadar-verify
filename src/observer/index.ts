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
  PortalExpectation,
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
export { assertClickPathSample } from './assert-click-path-sample.js';
export { assertContractEventFired } from './assert-contract-event-fired.js';
export { assertDataMutation } from './assert-data-mutation.js';
export { assertPortalPerStep } from './assert-portal-per-step.js';
export { assertInteractionPattern } from './assert-interaction-pattern.js';
export { assertClickNoListener } from './assert-click-no-listener.js';
export { report, type ReportInput } from './report.js';
export {
  probeListenCascades,
  type CascadeProbeCheck,
  type CascadeProbeFinding,
  type CascadeProbeResult,
} from './probe-listen-cascades.js';
