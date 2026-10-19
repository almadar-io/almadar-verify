/**
 * A kernel-only client's snapshot holds each trait's own frame, never a list's rows, so the driver adds the rows the page
 * renders: each server row (`listEntityRows`) whose id a `[data-entity-row]` shows, for the entities the step touches
 * (G-ORBITAL-SHELL-TYPESCRIPT-026). Every reader of the snapshot then sees them: the row picker, the crud judge's row
 * counts, the replay's row binding.
 *
 * @packageDocumentation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { EntityRow } from '@almadar/core';
import { withRenderedRows } from '../default-snapshot.js';
import type { SnapshotResult } from '../../types.js';

const server: Record<string, EntityRow[]> = {
  Note: [{ id: 'note-1', title: 'First' }, { id: 'note-2', title: 'Second' }, { id: 'note-3', title: 'Third' }],
  Tag: [{ id: 'tag-1', label: 'Red' }],
};
const listRows = async (entity: string): Promise<EntityRow[]> => server[entity] ?? [];

const empty = (entityData: SnapshotResult['entityData'] = {}): SnapshotResult => ({
  runtimeSnapshot: { checks: [], transitions: [], bridge: null, summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 }, traits: [] },
  dom: { url: 'about:blank', rowsByEntity: {}, portals: [], visibleTextSample: '' },
  consoleAdded: [], eventLogAdded: [], effectResults: [], serverResponse: null, entityData, screenshotPath: null,
});

describe('withRenderedRows', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(`
      <div data-entity-row data-entity-id="note-1">First</div>
      <div data-entity-row data-entity-id="note-3">Third</div>
      <div data-entity-id="note-2">a detail, not a row</div>
    `);
  }, 30000);

  afterAll(async () => {
    await browser.close();
  });

  it('adds the server rows the page renders, and counts them', async () => {
    const out = await withRenderedRows(empty(), page, ['Note'], listRows);
    expect(out.entityData['Note']?.map((r) => r['id'])).toEqual(['note-1', 'note-3']);
    expect(out.dom.rowsByEntity['Note']).toBe(2);
  });

  it('control: an entity the page renders no row of gains nothing', async () => {
    const out = await withRenderedRows(empty(), page, ['Tag'], listRows);
    expect(out.entityData['Tag']).toBeUndefined();
  });

  it('edge: a row the snapshot already holds is not added twice', async () => {
    const out = await withRenderedRows(empty({ Note: [{ id: 'note-1', title: 'First' }] }), page, ['Note'], listRows);
    expect(out.entityData['Note']?.map((r) => r['id'])).toEqual(['note-1', 'note-3']);
  });

  it('edge: a server that cannot say leaves the snapshot as it was', async () => {
    const out = await withRenderedRows(empty(), page, ['Note'], async () => { throw new Error('404'); });
    expect(out.entityData).toEqual({});
  });
});
