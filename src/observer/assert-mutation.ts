/**
 * `assertMutation` — single observer covering BOTH count delta (VG11b/d)
 * AND per-field content (VG11f).
 *
 * Reads `EntityChange.added/removed/changed` directly from the Frame —
 * those carry the actual `EntityRow` objects, not just counts. When
 * `rule.requiredFields` is set, the observer also asserts every required
 * field on every added row has a non-empty `FieldValue`, mirroring the
 * existing `probeEntityRowContent` semantics (skips framework-managed
 * fields and fields with a declared `default`).
 *
 * Pure. Operates on one Frame + the previous Frame.
 *
 * @packageDocumentation
 */

import type { EntityRow, FieldValue } from '@almadar/core';
import type { Frame } from '../frame/types.js';
import type {
  EntityRowContentVerdict,
  FieldContentCheck,
  MutationRule,
  Verdict,
} from './types.js';
import type { EntityFieldLike } from '../browser/catalog-probes.js';

const FRAMEWORK_FIELDS = new Set(['id', 'createdAt', 'updatedAt']);

export function assertMutation(
  frame: Frame,
  _prev: Frame | null,
  rule: MutationRule,
): Verdict {
  const change = frame.entityChanges.find((c) => c.entityName === rule.entityName);
  if (change === undefined) {
    return {
      passed: false,
      detail: `assertMutation: no entity change recorded for "${rule.entityName}" on frame ${frame.index}`,
      evidence: { frameIndices: [frame.index] },
    };
  }

  const actualDelta = change.added.length - change.removed.length;
  const countOk = actualDelta === rule.expectedDelta;
  if (!countOk) {
    return {
      passed: false,
      detail: `assertMutation: ${rule.entityName} expected delta ${rule.expectedDelta}, got ${actualDelta} (added=${change.added.length}, removed=${change.removed.length}) on frame ${frame.index}`,
      evidence: { frameIndices: [frame.index] },
    };
  }

  // Count check passed. If no requiredFields, we're done.
  if (rule.requiredFields === undefined || rule.requiredFields.length === 0) {
    return {
      passed: true,
      detail: `assertMutation: ${rule.entityName} count delta = ${actualDelta} on frame ${frame.index}`,
      evidence: { frameIndices: [frame.index] },
    };
  }

  // Field-content sweep over every added row.
  const rowsInspected: EntityRowContentVerdict[] = change.added.map((row) =>
    inspectRow(row, rule.requiredFields ?? []),
  );
  const allPassed = rowsInspected.every((r) => r.passed);
  return {
    passed: allPassed,
    detail: allPassed
      ? `assertMutation: ${rule.entityName} count + content OK on frame ${frame.index}`
      : `assertMutation: ${rule.entityName} count OK but content failed on frame ${frame.index}`,
    evidence: { frameIndices: [frame.index], rowsInspected },
  };
}

// ── internal ─────────────────────────────────────────────────────────

function inspectRow(
  row: EntityRow,
  requiredFields: ReadonlyArray<EntityFieldLike>,
): EntityRowContentVerdict {
  const checks: FieldContentCheck[] = [];

  for (const field of requiredFields) {
    if (FRAMEWORK_FIELDS.has(field.name)) continue;
    if (field.required !== true) continue;
    // Fields with a declared default are exempt — the schema accepts the default.
    if (field.default !== undefined && field.default !== null) continue;

    const value = row[field.name];
    const present = isNonEmpty(value);
    checks.push({
      field: field.name,
      present,
      value,
      detail: present
        ? `field "${field.name}" present`
        : `field "${field.name}" missing or empty`,
    });
  }

  const passed = checks.every((c) => c.present);
  const rowId = typeof row.id === 'string' ? row.id : '<no-id>';
  return {
    rowId,
    passed,
    checks,
    detail: passed
      ? `row ${rowId}: all required fields populated`
      : `row ${rowId}: ${checks.filter((c) => !c.present).map((c) => c.field).join(', ')} missing/empty`,
  };
}

function isNonEmpty(value: FieldValue | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return true;
  // numbers (incl. 0), booleans (incl. false), and objects all count.
  return true;
}
