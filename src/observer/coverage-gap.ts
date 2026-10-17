/**
 * A coverage gap: a declared transition the verifier cannot reach on its own, counted apart from covered and
 * uncovered transitions (never a pass, never a failure).
 *
 * @packageDocumentation
 */

export const COVERAGE_GAP_REASONS = {
  notReachableWithoutNetwork: 'not-reachable-without-network',
} as const;

export type CoverageGapReason = (typeof COVERAGE_GAP_REASONS)[keyof typeof COVERAGE_GAP_REASONS];

export interface CoverageGap {
  /** The schema-transition base key `${trait}:${from}+${event}->${to}`. */
  key: string;
  traitName: string;
  from: string;
  event: string;
  to: string;
  reason: CoverageGapReason;
  /** A failure-route arm: credited as covered, not a gap, when the request step's real dispatch fired it. */
  creditedWhenFired: boolean;
}
