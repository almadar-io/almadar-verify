/**
 * Pipeline type contracts.
 *
 * @packageDocumentation
 */

import type { OrbitalSchema } from '@almadar/core';
import type { Driver, DriverContext } from '../driver/types.js';
import type { Frame } from '../frame/types.js';
import type {
  CascadeRule,
  MutationRule,
  PortalExpectation,
  ReportShape,
} from '../observer/types.js';
import type { ContractRegistry } from '../planner/plan-contract-events.js';

/**
 * Input to `runVerification`. Generic over `Ctx` so the consumer's
 * choice of transport (Playwright, Puppeteer, Fake) is preserved
 * end-to-end without casts.
 *
 * v3.0.0 contract: takes the parsed `OrbitalSchema` directly. Verify
 * derives traits + render sites + interaction tests + data mutation
 * tests + contract events internally via the planners. Consumer tools
 * are pure environment setup — they parse the `.orb`, start the
 * server, build a Driver, hand off to `runVerification`.
 */
export interface RunVerificationInput<Ctx extends DriverContext> {
  /** Identifier for the report (e.g. behavior or atom name). */
  itemName: string;
  /** Parsed orbital schema from `@almadar/core`'s `parseOrbitalSchema`. */
  orbital: OrbitalSchema;
  /** Driver impl that exposes the four required methods. */
  driver: Driver<Ctx>;
  /**
   * Base context the kernel threads through. `tick()` overrides the
   * `trait` field per trait; the rest (page, outputDir, runtime, etc.)
   * is opaque.
   */
  ctx: Omit<Ctx, 'trait'>;
  options?: {
    /** Run Phase 4b interaction tests (DOM-trigger render-ui patterns). Default: true. */
    enableInteractionTests?: boolean;
    /** Run Phase 4c contract event coverage. Requires `contractRegistry`. Default: true. */
    enableContractEvents?: boolean;
    /** Run Phase 4b+ data mutation tests (CRUD). Default: true. */
    enableDataMutationTests?: boolean;
    /**
     * v3.7.0 — run the CRUD-proof phase: per-entity user-flow chains
     * (CREATE → EDIT → DELETE) with three-axis verdict (emit + entity
     * diff + DOM list update). Default: true.
     */
    enableUserCrudFlow?: boolean;
    /** Run VG3 click-path samples. Default: true. */
    enableClickPathSamples?: boolean;
    /** Run VG1 portal-per-step (built from render-ui in transitions). Default: true. */
    enablePortalPerStep?: boolean;
    /**
     * Pattern → emit registry from `event-contracts.json` files.
     * Required when `enableContractEvents` is true.
     */
    contractRegistry?: ContractRegistry;
    /** Per-trait time budget in ms. Default: 60000. */
    maxWalkMs?: number;
    /** Safety bound on the total Frame stream length. Default: 5000. */
    maxFrames?: number;
    /** Whether to capture screenshots (passed through to the Driver). Default: true. */
    screenshots?: boolean;
    /**
     * Credit a step even when `getState` returns `null` after settle
     * (the driver exposes no state reader). Default falsey — the kernel
     * fails closed and stamps a `stateless dispatch` error on any frame
     * whose `stateAfter` is `null`. Only set this for drivers that
     * genuinely cannot read state.
     */
    allowStateless?: boolean;
    /** Logger used for progress output. Default: `console.log`. */
    log?: (msg: string) => void;
    /**
     * Called after each `tick()` returns a settled `Frame`, before
     * the kernel proceeds to the next step. Lets consumers run
     * side-effects against the live runtime — e.g. inject the
     * `Annotator` overlay into the Playwright page for the
     * interactive `--annotate` mode. The hook receives the kernel's
     * `ctx` (the same `Omit<Ctx, 'trait'>` the consumer passed in,
     * with the current trait stamped on) so a Playwright impl can
     * reach `ctx.page` to drive its overlay.
     *
     * Errors thrown from the hook do NOT halt the run — they're
     * caught and logged via `options.log` so a flaky annotation
     * round-trip can't take down a long verifier walk. Hooks that
     * need hard-stop semantics should call `process.exit` themselves.
     *
     * Frame-level annotation output (JSONL append, in-memory list,
     * etc.) is the consumer's responsibility — see `Annotator` in
     * `@almadar-io/verify` for the canonical Playwright wiring.
     */
    onFrameSettle?: (ctx: Ctx, frame: Frame) => Promise<void> | void;
  };
}

/** Runtime output of `runVerification` — the same shape `report()` produces. */
export type RunVerificationOutput = ReportShape;
