/**
 * The frame screenshot file name: one deterministic name per (trait, step,
 * variant) so base-walk and interaction-test frames for the same transition
 * never overwrite each other. Shared by every driver impl.
 *
 * @packageDocumentation
 */

import { safeFileName } from '../../browser/screenshot.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

export function frameScreenshotFileName(traitName: string, step: ExtendedWalkStep): string {
  // safeFileName strips dots, so sanitize the basename then append the extension.
  let variant = '';
  if (step.testKind !== undefined) variant = `__${step.testKind}`;
  else if (step.triggerKind === 'reconcile') variant = '__reconcile';
  else if (step.payloadCase !== undefined) variant = `__${step.payloadCase}`;
  return `${safeFileName(`${traitName}_${step.from}_${step.event}_${step.to}${variant}`)}.png`;
}
