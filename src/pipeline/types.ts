/**
 * Pipeline type contracts.
 *
 * @packageDocumentation
 */

import type { Driver, DriverContext } from '../driver/types.js';
import type { TraitWalkConfig } from '../engine/types.js';
import type { CascadeRule, MutationRule, ReportShape } from '../observer/types.js';

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
  /** Optional rules consumed by `assertCascade` / `assertMutation`. */
  rules?: {
    cascade?: ReadonlyArray<CascadeRule>;
    mutation?: ReadonlyArray<MutationRule>;
  };
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
