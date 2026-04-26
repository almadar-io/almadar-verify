/**
 * Pipeline type contracts.
 *
 * @packageDocumentation
 */

import type { Driver, DriverContext } from '../driver/types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import type {
  CascadeRule,
  MutationRule,
  PortalExpectation,
  ReportShape,
} from '../observer/types.js';
import type { ExtendedWalkStep } from '../planner/types.js';

/**
 * A planner extension. Pure function over the trait list. Returns
 * additional steps to append to the base `planWalk` output. The kernel
 * runs them in the same `tick` loop as the base steps; observers see
 * the combined Frame stream.
 *
 * Tool-specific plan data (orbital's `UnifiedTestPlan`, runtime-verify's
 * `BehaviorSchema`) is captured via lexical scope at the consumer site:
 *
 *   const interactionExtension: PlanExtension =
 *     (traits) => planInteractionTests(traits, orbitalPlan);
 *
 * The kernel never sees tool-shaped data — keeps verify free of
 * `unknown` and free of consumer type imports.
 *
 * Examples:
 *   planInteractionTests, planContractEvents, planDataMutationTests,
 *   planClickPathSamples (lifted from orbital's Phase 4b/4b+/4c/VG3).
 */
export type PlanExtension = (traits: ReadonlyArray<TraitWalkConfig>) => ReadonlyArray<ExtendedWalkStep>;

/**
 * Input to `runVerification`. Generic over `Ctx` so the consumer's
 * choice of transport (Playwright, Puppeteer, Fake) is preserved
 * end-to-end without casts.
 */
export interface RunVerificationInput<Ctx extends DriverContext> {
  /** Identifier for the report (e.g. behavior or atom name). */
  itemName: string;
  /** Traits to walk in order. */
  traits: ReadonlyArray<TraitWalkConfig>;
  /** Driver impl that exposes the four required methods. */
  driver: Driver<Ctx>;
  /**
   * Base context the kernel threads through. `tick()` overrides the
   * `trait` field per trait; the rest (page, outputDir, runtime, etc.)
   * is opaque.
   */
  ctx: Omit<Ctx, 'trait'>;
  /** Optional rules consumed by `assertCascade` / `assertMutation` / `assertPortalPerStep`. */
  rules?: {
    cascade?: ReadonlyArray<CascadeRule>;
    mutation?: ReadonlyArray<MutationRule>;
    /** VG1 — per-transition portal slot expectations. */
    portal?: ReadonlyArray<PortalExpectation>;
  };
  /**
   * Optional planner extensions. Each is a pure function called once
   * per `runVerification` call (with the full trait list); their
   * `ExtendedWalkStep[]` outputs are appended to the base walk and
   * fired via the same `tick` loop. Observers see the combined Frame
   * stream.
   *
   * Tool-specific plan data is captured via closure at the consumer
   * site, so the kernel never sees tool-shaped types:
   *
   *   const ext: PlanExtension =
   *     (traits) => planInteractionTests(traits, orbitalPlan);
   *
   * orbital wires its lifted Phase 4b/4b+/4c/VG3 logic here:
   *   planExtensions: [
   *     (t) => planInteractionTests(t, plan),
   *     (t) => planContractEvents(t, plan, contractRegistry),
   *     (t) => planDataMutationTests(t, plan),
   *     (t) => planClickPathSamples(t, plan),
   *   ]
   */
  planExtensions?: ReadonlyArray<PlanExtension>;
  options?: {
    /** Per-trait time budget in ms. Default: 60000. */
    maxWalkMs?: number;
    /** Safety bound on the total Frame stream length. Default: 5000. */
    maxFrames?: number;
    /** Whether to capture screenshots (passed through to the Driver). Default: true. */
    screenshots?: boolean;
    /** Logger used for progress output. Default: `console.log`. */
    log?: (msg: string) => void;
  };
}

/** Runtime output of `runVerification` — the same shape `report()` produces. */
export type RunVerificationOutput = ReportShape;
