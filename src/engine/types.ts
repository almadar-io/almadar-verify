/**
 * `TraitWalkConfig` — the per-trait input shape the kernel walks.
 *
 * Lives here for historical reasons (it predates the planner/driver
 * split). New consumers should import from this path; future cleanup
 * may relocate to `planner/types.ts` once no external dependencies
 * remain on `@almadar-io/verify/engine`.
 *
 * The legacy `StateWalkEngine` class, `EngineAdapter` interface,
 * `EngineConfig`, and `WalkResult` types were removed in v2.0.0 along
 * with the back-compat shim path. Migrate to:
 *   - `runVerification` (from `pipeline/`) instead of `StateWalkEngine.walk()`
 *   - `Driver<Ctx>` (from `driver/`) instead of `EngineAdapter`
 *   - `ReportShape` + `coverage()` (from `observer/`) instead of `WalkResult`
 *
 * @packageDocumentation
 */

import type { EdgeWalkTransition, WalkStep } from '@almadar/core';

/** Configuration for a single trait's walk. */
export interface TraitWalkConfig {
  traitName: string;
  initialState: string;
  transitions: EdgeWalkTransition[];
  /** Route path for this trait's page (e.g., "products", "orders"). */
  route?: string;
}

export type { WalkStep, EdgeWalkTransition };
