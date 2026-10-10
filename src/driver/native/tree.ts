/**
 * Native accessibility tree: the one shape both platform trees reduce to, the
 * affordance resolver `triggerDOM` uses, and the `DomSnapshot` projection.
 *
 * Selectors come only from `@almadar/core`'s verification contract
 * (`action-<EVENT>`, `pattern-<name>`, `row-<id>`, `field-<name>`, `slot-<name>`). Row scope
 * is hierarchical: an action belongs to a row when the row container is one of
 * its ancestors.
 *
 * Portal mapping (`treeToPortals`): a slot is mounted when its `slot-<name>`
 * container is in the tree. Its `childCount` is the number of top-level
 * `pattern-*` elements whose nearest slot ancestor is that slot (a pattern
 * nested inside another pattern does not count) and its `pattern` is the first
 * of them in tree order. A slot with no container is reported unmounted.
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import { actionTestIdMatches, ACTION_OVERFLOW_TESTID, NATIVE_ID_PREFIX, nativeFieldId, nativeSlotId } from '@almadar/core';
import type { DomSnapshot } from '../../frame/types.js';
import { PORTAL_SLOTS, type PortalSlot } from '../../browser/portal-slots.js';

export interface NativeBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NativeElement {
  id: string;
  type: string;
  label: string;
  value: string;
  bounds: NativeBounds;
  enabled: boolean;
  hittable: boolean;
  /** Identifiers of the identified ancestors, outermost first. */
  ancestors: ReadonlyArray<string>;
}

const iosTreeSchema = z.object({
  elements: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      value: z.string(),
      frame: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      enabled: z.boolean(),
      hittable: z.boolean().optional(),
      ancestors: z.array(z.string()),
    }),
  ),
});

/** Parse the iOS verify driver's `GET /tree` body. `hittable` is absent when the driver was asked for `?hittable=0`; absent means visible. */
export function parseIosTree(json: string): NativeElement[] {
  const parsed = iosTreeSchema.parse(JSON.parse(json));
  return parsed.elements.map((el) => ({
    id: el.id,
    type: el.type,
    label: el.label,
    value: el.value,
    bounds: el.frame,
    enabled: el.enabled,
    hittable: el.hittable !== false,
    ancestors: el.ancestors,
  }));
}

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return XML_ENTITIES[body] ?? whole;
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const pattern = /([\w:.-]+)="([^"]*)"/g;
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    attrs.set(m[1]!, decodeXml(m[2]!));
  }
  return attrs;
}

function parseBounds(raw: string | undefined): NativeBounds {
  const m = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw ?? '');
  if (m === null) throw new Error(`uiautomator bounds not in [l,t][r,b] form: ${raw ?? '<absent>'}`);
  const [l, t, r, b] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
  return { x: l, y: t, w: r - l, h: b - t };
}

/**
 * Parse a `uiautomator dump` document. Only nodes with a non-empty
 * `resource-id` (the Compose testTag, with `testTagsAsResourceId` on) become
 * elements; `ancestors` lists the identified nodes enclosing each. A dump lists
 * visible nodes only, so `hittable` means "has area and is enabled".
 */
export function parseAndroidDump(xml: string): NativeElement[] {
  const elements: NativeElement[] = [];
  const open: Array<string | null> = [];
  const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
  for (let m = tag.exec(xml); m !== null; m = tag.exec(xml)) {
    if (m[1] === '/') {
      open.pop();
      continue;
    }
    const attrs = parseAttributes(m[2]!);
    const id = attrs.get('resource-id') ?? '';
    if (id !== '') {
      const bounds = parseBounds(attrs.get('bounds'));
      const enabled = attrs.get('enabled') !== 'false';
      elements.push({
        id,
        type: attrs.get('class') ?? '',
        label: attrs.get('content-desc') || attrs.get('text') || '',
        value: attrs.get('text') ?? '',
        bounds,
        enabled,
        hittable: enabled && bounds.w > 0 && bounds.h > 0,
        ancestors: open.filter((entry): entry is string => entry !== null),
      });
    }
    if (m[3] !== '/') open.push(id === '' ? null : id);
  }
  return elements;
}

export function isRowContainer(el: NativeElement): boolean {
  return el.id.startsWith(NATIVE_ID_PREFIX.row);
}

export interface AffordanceScope {
  /** `nativeRowId(...)` of the row to act in. */
  rowId?: string;
  /** Take the first `row-*` container in tree order (the deterministic structural position). */
  firstRow?: boolean;
  /** Only elements that sit inside no row container: a portalled overflow menu item carries no row identity. */
  outsideRows?: boolean;
}

export interface ResolvedAffordance {
  element: NativeElement;
  /** Row container id to pass as `within` when the element was found by row scope. */
  within?: string;
}

function usable(el: NativeElement): boolean {
  return el.hittable && el.enabled;
}

function insideRow(el: NativeElement, rowId: string): boolean {
  return el.ancestors.includes(rowId);
}

/** The first row container in tree order, or null. */
export function firstRowId(tree: ReadonlyArray<NativeElement>): string | null {
  return tree.find(isRowContainer)?.id ?? null;
}

/** True when any element dispatching `event` sits inside some row container. */
export function actionIsRowTagged(tree: ReadonlyArray<NativeElement>, event: string): boolean {
  return tree.some((el) => actionTestIdMatches(el.id, event) && el.ancestors.some((a) => a.startsWith(NATIVE_ID_PREFIX.row)));
}

/** First usable element dispatching `event`, inside `scope` when one is given. */
export function resolveAction(
  tree: ReadonlyArray<NativeElement>,
  event: string,
  scope: AffordanceScope = {},
): ResolvedAffordance | null {
  const rowId = scope.rowId ?? (scope.firstRow === true ? firstRowId(tree) : null);
  if (scope.rowId !== undefined || scope.firstRow === true) {
    if (rowId === null) return null;
    const element = tree.find((el) => actionTestIdMatches(el.id, event) && insideRow(el, rowId) && usable(el));
    return element === undefined ? null : { element, within: rowId };
  }
  const element = tree.find(
    (el) => actionTestIdMatches(el.id, event) && usable(el) && (scope.outsideRows !== true || !el.ancestors.some((a) => a.startsWith(NATIVE_ID_PREFIX.row))),
  );
  return element === undefined ? null : { element };
}

/** The row's overflow ("...") control, inside `scope`. */
export function resolveOverflow(tree: ReadonlyArray<NativeElement>, scope: AffordanceScope): ResolvedAffordance | null {
  const rowId = scope.rowId ?? (scope.firstRow === true ? firstRowId(tree) : null);
  if (rowId === null) return null;
  const element = tree.find((el) => el.id === ACTION_OVERFLOW_TESTID && insideRow(el, rowId) && usable(el));
  return element === undefined ? null : { element, within: rowId };
}

export function resolveField(tree: ReadonlyArray<NativeElement>, name: string, formId?: string): NativeElement | null {
  const id = nativeFieldId(name);
  return tree.find((el) => el.id === id && usable(el) && (formId === undefined || insideRow(el, formId))) ?? null;
}

/** Usable `field-*` elements inside the form container `formId`, in tree order. */
export function fieldsInside(tree: ReadonlyArray<NativeElement>, formId: string): NativeElement[] {
  return tree.filter((el) => el.id.startsWith(NATIVE_ID_PREFIX.field) && insideRow(el, formId) && usable(el));
}

/** Row ids (`row-<id>` stripped of the prefix) in tree order, de-duplicated. */
export function rowIds(tree: ReadonlyArray<NativeElement>): string[] {
  const seen = new Set<string>();
  for (const el of tree) {
    if (isRowContainer(el)) seen.add(el.id.slice(NATIVE_ID_PREFIX.row.length));
  }
  return [...seen];
}

function slotPatternRoots(tree: ReadonlyArray<NativeElement>, slotId: string): NativeElement[] {
  return tree.filter((el) => {
    if (!el.id.startsWith(NATIVE_ID_PREFIX.pattern)) return false;
    let below: string[] = [];
    let nearest: string | undefined;
    for (const a of el.ancestors) {
      if (a.startsWith(NATIVE_ID_PREFIX.slot)) {
        nearest = a;
        below = [];
      } else {
        below.push(a);
      }
    }
    return nearest === slotId && !below.some((a) => a.startsWith(NATIVE_ID_PREFIX.pattern));
  });
}

export function treeToPortals(tree: ReadonlyArray<NativeElement>): DomSnapshot['portals'] {
  return (PORTAL_SLOTS as ReadonlyArray<PortalSlot>).map((slot) => {
    const slotId = nativeSlotId(slot);
    if (!tree.some((el) => el.id === slotId)) return { slot, mounted: false, childCount: 0 };
    const roots = slotPatternRoots(tree, slotId);
    return {
      slot,
      mounted: true,
      childCount: roots.length,
      ...(roots.length > 0 && { pattern: roots[0]!.id.slice(NATIVE_ID_PREFIX.pattern.length) }),
    };
  });
}

/** Labels of the tree's elements in tree order, joined; the field is a bounded sample (256 characters) by its contract. */
export function treeVisibleText(tree: ReadonlyArray<NativeElement>): string {
  return tree
    .filter((el) => el.hittable && el.label !== '')
    .map((el) => el.label)
    .join(' ')
    .slice(0, 256);
}

export function treeToDomSnapshot(
  tree: ReadonlyArray<NativeElement>,
  url: string,
  rowsByEntity: Record<string, number>,
): DomSnapshot {
  return { url, rowsByEntity, portals: treeToPortals(tree), visibleTextSample: treeVisibleText(tree) };
}
