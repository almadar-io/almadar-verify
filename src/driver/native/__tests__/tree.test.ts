import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseIosTree,
  parseAndroidDump,
  resolveAction,
  resolveOverflow,
  resolveField,
  fieldsInside,
  rowIds,
  treeToPortals,
  treeVisibleText,
  treeToDomSnapshot,
  actionIsRowTagged,
  type NativeElement,
} from '../tree.js';
import { PORTAL_SLOTS } from '../../../browser/portal-slots.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, '..', '__fixtures__', name), 'utf8');
const ios = (): NativeElement[] => parseIosTree(fixture('ios-tree.json'));
const android = (): NativeElement[] => parseAndroidDump(fixture('android-dump.xml'));

describe('parseIosTree', () => {
  it('maps the driver /tree body to native elements', () => {
    const tree = ios();
    const edit = tree.find((e) => e.id === 'action-EDIT');
    expect(edit).toMatchObject({ type: 'button', label: 'Edit', hittable: true, ancestors: ['pattern-entity-table', 'row-3'] });
    expect(edit?.bounds).toEqual({ x: 300, y: 110, w: 60, h: 40 });
  });

  it('control: a body missing a required field is rejected, not defaulted', () => {
    expect(() => parseIosTree(JSON.stringify({ elements: [{ id: 'a' }] }))).toThrow();
  });

  it('treats an absent hittable (hittable=0 query) as visible', () => {
    const body = { elements: [{ id: 'a', type: 'button', label: '', value: '', frame: { x: 0, y: 0, w: 1, h: 1 }, enabled: true, ancestors: [] }] };
    expect(parseIosTree(JSON.stringify(body))[0]?.hittable).toBe(true);
  });
});

describe('parseAndroidDump', () => {
  it('keeps only resource-id nodes and records identified ancestors', () => {
    const tree = android();
    expect(tree.map((e) => e.id)).toEqual([
      'pattern-entity-table', 'row-3', 'action-EDIT', 'action-Tasks.TaskBrowse.DELETE', 'row-5', 'action-EDIT',
      'action-CREATE', 'action-ARCHIVE', 'pattern-form-section', 'field-title', 'action-SAVE',
    ]);
    const edits = tree.filter((e) => e.id === 'action-EDIT');
    expect(edits.map((e) => e.ancestors)).toEqual([
      ['pattern-entity-table', 'row-3'],
      ['pattern-entity-table', 'row-5'],
    ]);
  });

  it('decodes XML entities and derives bounds', () => {
    const row = android().find((e) => e.id === 'row-3');
    expect(row?.label).toBe('Milk & Honey');
    expect(row?.bounds).toEqual({ x: 0, y: 200, w: 1080, h: 160 });
  });

  it('marks a disabled node as not hittable; control: an enabled node is', () => {
    const tree = android();
    expect(tree.find((e) => e.id === 'action-ARCHIVE')?.hittable).toBe(false);
    expect(tree.find((e) => e.id === 'action-CREATE')?.hittable).toBe(true);
  });

  it('rejects a node whose bounds are malformed', () => {
    const bad = '<hierarchy><node resource-id="action-X" bounds="oops" enabled="true"/></hierarchy>';
    expect(() => parseAndroidDump(bad)).toThrow(/bounds/);
  });

  it('control: a dump with no identified nodes yields no elements', () => {
    expect(parseAndroidDump('<hierarchy><node resource-id="" bounds="[0,0][1,1]"/></hierarchy>')).toEqual([]);
  });
});

describe.each([
  ['ios', ios],
  ['android', android],
] as const)('resolveAction (%s)', (_name, load) => {
  it('scopes to the target row hierarchically', () => {
    const hit = resolveAction(load(), 'EDIT', { rowId: 'row-5' });
    expect(hit?.within).toBe('row-5');
    expect(hit?.element.ancestors).toContain('row-5');
  });

  it('with firstRow takes the first row in tree order', () => {
    expect(resolveAction(load(), 'EDIT', { firstRow: true })?.within).toBe('row-3');
  });

  it('matches a qualified action id by its trailing event', () => {
    expect(resolveAction(load(), 'DELETE', { rowId: 'row-3' })?.element.id).toBe('action-Tasks.TaskBrowse.DELETE');
  });

  it('control: a row without that action resolves to null, never to another row', () => {
    expect(resolveAction(load(), 'DELETE', { rowId: 'row-5' })).toBeNull();
  });

  it('control: an unknown row resolves to null', () => {
    expect(resolveAction(load(), 'EDIT', { rowId: 'row-99' })).toBeNull();
  });

  it('outsideRows skips row-scoped matches; control: without it the first row match wins', () => {
    expect(resolveAction(load(), 'EDIT', { outsideRows: true })).toBeNull();
    expect(resolveAction(load(), 'EDIT', {})?.element.ancestors).toContain('row-3');
  });

  it('unscoped resolution takes the first usable match', () => {
    expect(resolveAction(load(), 'CREATE')?.element.id).toBe('action-CREATE');
  });

  it('does not treat a longer event as a match (EDIT vs CREDIT)', () => {
    expect(resolveAction(load(), 'REDIT')).toBeNull();
  });
});

describe('resolveAction visibility', () => {
  it('skips a non-hittable iOS element; control: its hittable sibling resolves', () => {
    expect(resolveAction(ios(), 'HIDDEN')).toBeNull();
    expect(resolveAction(ios(), 'SAVE')).not.toBeNull();
  });

  it('skips a disabled Android element', () => {
    expect(resolveAction(android(), 'ARCHIVE')).toBeNull();
  });
});

describe('row helpers', () => {
  it('lists row ids in tree order', () => {
    expect(rowIds(ios())).toEqual(['3', '5']);
  });

  it('knows whether an action is rendered inside rows at all', () => {
    expect(actionIsRowTagged(ios(), 'EDIT')).toBe(true);
    expect(actionIsRowTagged(ios(), 'CREATE')).toBe(false);
  });

  it('resolves the overflow control only inside the asked row', () => {
    expect(resolveOverflow(ios(), { rowId: 'row-5' })?.within).toBe('row-5');
    expect(resolveOverflow(ios(), { rowId: 'row-3' })).toBeNull();
  });
});

describe('fields', () => {
  it('resolves a field-<name> element', () => {
    expect(resolveField(ios(), 'title')?.type).toBe('textField');
    expect(resolveField(android(), 'title')?.type).toBe('android.widget.EditText');
  });

  it('control: an undeclared field is null', () => {
    expect(resolveField(ios(), 'nope')).toBeNull();
  });

  it('lists the fields inside a form container', () => {
    expect(fieldsInside(ios(), 'pattern-form-section').map((e) => e.id)).toEqual(['field-title', 'field-notes']);
  });
});

describe.each([
  ['ios', (name: string) => parseIosTree(fixture(`ios-tree-slots-${name}.json`))],
  ['android', (name: string) => parseAndroidDump(fixture(`android-dump-slots-${name}.xml`))],
] as const)('treeToPortals (%s)', (_name, load) => {
  it('mounts the modal slot with its top-level pattern when the modal is open', () => {
    const portals = treeToPortals(load('modal-open'));
    expect(portals.find((p) => p.slot === 'modal')).toEqual({ slot: 'modal', mounted: true, childCount: 1, pattern: 'form-section' });
    expect(portals.find((p) => p.slot === 'main')).toEqual({ slot: 'main', mounted: true, childCount: 2, pattern: 'entity-table' });
  });

  it('control: the closed modal is reported unmounted and main is unchanged', () => {
    const portals = treeToPortals(load('modal-closed'));
    expect(portals.find((p) => p.slot === 'modal')).toEqual({ slot: 'modal', mounted: false, childCount: 0 });
    expect(portals.find((p) => p.slot === 'main')).toEqual({ slot: 'main', mounted: true, childCount: 2, pattern: 'entity-table' });
  });

  it('control: every other slot stays unmounted, and every portal slot is reported once', () => {
    const portals = treeToPortals(load('modal-open'));
    expect(portals.map((p) => p.slot)).toEqual([...PORTAL_SLOTS]);
    expect(portals.filter((p) => p.mounted).map((p) => p.slot)).toEqual(['main', 'modal']);
  });

  it('does not count a nested pattern toward its slot', () => {
    const portals = treeToPortals(load('modal-open'));
    expect(portals.find((p) => p.slot === 'main')?.childCount).toBe(2);
    expect(portals.find((p) => p.slot === 'modal')?.childCount).toBe(1);
  });
});

describe('treeToPortals', () => {
  it('control: an empty tree mounts nothing', () => {
    expect(treeToPortals([]).every((p) => !p.mounted && p.childCount === 0)).toBe(true);
  });

  it('a pattern outside every slot container belongs to no portal', () => {
    const tree = parseAndroidDump('<hierarchy><node resource-id="pattern-a" bounds="[0,0][9,9]" enabled="true"/></hierarchy>');
    expect(treeToPortals(tree).every((p) => !p.mounted)).toBe(true);
  });

  it('a mounted slot with no pattern child has childCount 0 and no pattern', () => {
    const tree = parseAndroidDump('<hierarchy><node resource-id="slot-toast" bounds="[0,0][9,9]" enabled="true"/></hierarchy>');
    expect(treeToPortals(tree).find((p) => p.slot === 'toast')).toEqual({ slot: 'toast', mounted: true, childCount: 0 });
  });

  it('attributes a pattern to its nearest slot ancestor when slots nest', () => {
    const tree = parseAndroidDump(
      '<hierarchy><node resource-id="slot-main" bounds="[0,0][9,9]" enabled="true"><node resource-id="slot-modal" bounds="[0,0][9,9]" enabled="true"><node resource-id="pattern-x" bounds="[0,0][9,9]" enabled="true"/></node></node></hierarchy>',
    );
    const portals = treeToPortals(tree);
    expect(portals.find((p) => p.slot === 'modal')).toMatchObject({ mounted: true, childCount: 1, pattern: 'x' });
    expect(portals.find((p) => p.slot === 'main')).toMatchObject({ mounted: true, childCount: 0 });
  });

  it('ignores a slot-* container whose name is not a portal slot', () => {
    const tree = parseAndroidDump('<hierarchy><node resource-id="slot-nonsense" bounds="[0,0][9,9]" enabled="true"/></hierarchy>');
    expect(treeToPortals(tree).every((p) => !p.mounted)).toBe(true);
  });
});

describe('treeVisibleText / treeToDomSnapshot', () => {
  it('joins visible labels in tree order and skips hidden ones', () => {
    const text = treeVisibleText(ios());
    expect(text.startsWith('Milk Edit Delete Eggs')).toBe(true);
    expect(text).not.toContain('Hidden');
  });

  it('is bounded to 256 characters by the DomSnapshot contract', () => {
    const long: NativeElement[] = Array.from({ length: 200 }, (_, i) => ({
      id: `x${i}`, type: 't', label: 'word', value: '', bounds: { x: 0, y: 0, w: 1, h: 1 }, enabled: true, hittable: true, ancestors: [],
    }));
    expect(treeVisibleText(long)).toHaveLength(256);
    expect(treeVisibleText(long.slice(0, 2))).toBe('word word');
  });

  it('assembles the snapshot with the supplied url and row counts', () => {
    const snap = treeToDomSnapshot(ios(), '', { Task: 2 });
    expect(snap.url).toBe('');
    expect(snap.rowsByEntity).toEqual({ Task: 2 });
    expect(snap.portals.every((p) => !p.mounted)).toBe(true);
  });
});
