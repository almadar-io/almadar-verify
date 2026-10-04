/**
 * Settled-render check (G-VERIFY-051): after a page settles, no loading or empty
 * view may stand for data its fetch already returned. Every gate checked form,
 * not this consequence: std-inventory /stock-levels sat on its spinner with 6
 * StockLevel rows loaded and std-construction-pm /site-diary showed "No events"
 * with 6 TimelineEntry rows.
 *
 * Structure only: the `EMPTY_STATE_MARKER` / `LOADING_STATE_MARKER` attributes
 * the render substrate stamps, the `data-orb-trait` wrappers around each trait's
 * paint, and the per-entity row counts the verification timeline records for
 * every server response. No text is read.
 *
 * @packageDocumentation
 */
import type { Page } from 'playwright';
import { EMPTY_STATE_MARKER, LOADING_STATE_MARKER, type TransitionTrace } from '@almadar/core';

/** Elements that are one rendered entity row. */
export const ENTITY_ROW_SELECTOR = '[data-entity-row], [data-entity-id], [data-pattern="data-grid"] tbody tr, [data-pattern="data-list"] > *';

/** One empty, loading or blank view, with the traits that painted it (innermost first). */
export interface SettledNode {
  /** `blank`: a list rendering rows none of which shows a field value. */
  kind: 'empty' | 'loading' | 'blank';
  traits: string[];
  /** Rendered row count, for a `blank` view. */
  rows?: number;
}

export interface SettledFinding {
  kind: 'empty' | 'loading' | 'blank';
  trait: string;
  entity: string;
  rows: number;
}

export interface SettledRenderMeasurement {
  nodes: SettledNode[];
  /** Entity → the most rows any server response carried for it. */
  fetchedRows: Record<string, number>;
}

/** A finding per trait whose linked entity came back with rows while it shows an empty or loading view. */
export function classifySettledRender(
  nodes: readonly SettledNode[],
  entityOfTrait: ReadonlyMap<string, string>,
  fetchedRows: Readonly<Record<string, number>>,
): SettledFinding[] {
  const findings: SettledFinding[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const trait of node.traits) {
      const entity = entityOfTrait.get(trait);
      const rows = node.kind === 'blank' ? node.rows ?? 0 : entity !== undefined ? fetchedRows[entity] ?? 0 : 0;
      if (entity === undefined || rows === 0) continue;
      const key = `${node.kind}:${trait}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ kind: node.kind, trait, entity, rows });
      }
      break;
    }
  }
  return findings;
}

export function settledFindingMessage(f: SettledFinding): string {
  if (f.kind === 'blank') return `${f.trait} renders ${f.rows} ${f.entity} row(s) with no field values`;
  return f.kind === 'loading'
    ? `${f.trait} still shows a loading view after its fetch returned ${f.rows} ${f.entity} row(s)`
    : `${f.trait} shows an empty view though its fetch returned ${f.rows} ${f.entity} row(s)`;
}

export async function measureSettledRender(page: Page): Promise<SettledRenderMeasurement> {
  return page.evaluate(({ emptyMarker, loadingMarker, rowSelector }) => {
    const nodes: Array<{ kind: 'empty' | 'loading' | 'blank'; traits: string[]; rows?: number }> = [];
    const collect = (marker: string, kind: 'empty' | 'loading'): void => {
      for (const el of Array.from(document.querySelectorAll(`[${marker}]`))) {
        if (el.parentElement?.closest(`[${marker}]`)) continue;
        const traits: string[] = [];
        let partial = false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const trait = a.getAttribute('data-orb-trait');
          if (trait === null) continue;
          // A trait that renders rows elsewhere (a board's other columns) is a partial view, not an empty one.
          if (a.querySelector(rowSelector) !== null) {
            partial = true;
            break;
          }
          traits.push(trait);
        }
        if (!partial && traits.length > 0) nodes.push({ kind, traits });
      }
    };
    collect(emptyMarker, 'empty');
    collect(loadingMarker, 'loading');
    // A list whose every rendered row is textless shows rows of nothing.
    for (const list of Array.from(document.querySelectorAll('[data-pattern="data-grid"], [data-pattern="data-list"]'))) {
      const rows = Array.from(list.querySelectorAll(rowSelector));
      if (rows.length === 0 || rows.some((row) => (row.textContent ?? '').trim() !== '')) continue;
      const traits: string[] = [];
      for (let a = list.parentElement; a; a = a.parentElement) {
        const trait = a.getAttribute('data-orb-trait');
        if (trait !== null) traits.push(trait);
      }
      if (traits.length > 0) nodes.push({ kind: 'blank', traits, rows: rows.length });
    }

    const fetchedRows: Record<string, number> = {};
    const w = window as Window & { __orbitalVerification?: { getTransitions?: () => ReadonlyArray<TransitionTrace> } };
    for (const trace of w.__orbitalVerification?.getTransitions?.() ?? []) {
      for (const [entity, rows] of Object.entries(trace.serverResponse?.dataEntities ?? {})) {
        fetchedRows[entity] = Math.max(fetchedRows[entity] ?? 0, rows);
      }
    }
    return { nodes, fetchedRows };
  }, { emptyMarker: EMPTY_STATE_MARKER, loadingMarker: LOADING_STATE_MARKER, rowSelector: ENTITY_ROW_SELECTOR });
}
