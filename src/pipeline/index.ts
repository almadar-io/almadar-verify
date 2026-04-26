/**
 * `pipeline/` — composes plan → fold(tick) → observers → report.
 *
 * @packageDocumentation
 */

export { runVerification } from './run-verification.js';
export type {
  RunVerificationInput,
  RunVerificationOutput,
  PlanExtension,
} from './types.js';
