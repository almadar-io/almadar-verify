import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import type { FieldValue } from '@almadar/core';
import { launchBrowser } from '../launch.js';
import { fillFormFieldsFromMap } from '../interaction.js';
import { takeScreenshot } from '../screenshot.js';

describe('exact browser evidence', () => {
  let browser: Browser;
  let page: Page;
  const dir = mkdtempSync(join(tmpdir(), 'verify-exact-'));
  beforeAll(async () => {
    const launched = await launchBrowser({ timeout: 500 });
    browser = launched.browser;
    page = await launched.context.newPage();
  });
  afterAll(async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }); });

  it('rejects an undeclared select option instead of substituting a real option', async () => {
    await page.setContent('<form><select data-field-name="status"><option value="open">Open</option></select></form>');
    await expect(fillFormFieldsFromMap(page, 'form', { status: 'missing' }, { strict: true })).rejects.toThrow();
    expect(await fillFormFieldsFromMap(page, 'form', { status: 'open' }, { strict: true })).toBe(1);
    expect(await page.locator('select').inputValue()).toBe('open');
    expect(await fillFormFieldsFromMap(page, 'form', { status: 'missing' })).toBe(1);
  });

  it('rejects missing, hidden, ambiguous and non-scalar fields', async () => {
    await page.setContent('<form><input data-field-name="hidden" hidden><input data-field-name="dup"><input data-field-name="dup"></form>');
    const cases: Array<Record<string, FieldValue>> = [{ missing: 'x' }, { hidden: 'x' }, { dup: 'x' }, { object: { name: 'x' } }, { empty: null }];
    for (const data of cases) {
      await expect(fillFormFieldsFromMap(page, 'form', data, { strict: true })).rejects.toThrow();
    }
    expect(await fillFormFieldsFromMap(page, 'form', { missing: 'x' })).toBe(0);
  });

  it('preserves exact zero, false and empty string values', async () => {
    await page.setContent('<form><input type="number" data-field-name="amount"><input type="checkbox" checked data-field-name="done"><input data-field-name="title" value="old"></form>');
    expect(await fillFormFieldsFromMap(page, 'form', { amount: 0, done: false, title: '' }, { strict: true })).toBe(3);
    expect(await page.locator('[data-field-name="amount"]').inputValue()).toBe('0');
    expect(await page.locator('[data-field-name="done"]').isChecked()).toBe(false);
    expect(await page.locator('[data-field-name="title"]').inputValue()).toBe('');
  });

  it('fills declared native selectors through the same exact scalar loop', async () => {
    await page.setContent('<form><input id="draft"><textarea id="notes"></textarea><input id="amount" type="number"><input id="done" type="checkbox" checked><select id="status"><option value="open">Open</option></select></form>');
    const fieldSelectors = { draft: '#draft', notes: '#notes', amount: '#amount', done: '#done', status: '#status' };
    expect(await fillFormFieldsFromMap(page, 'form', { draft: 'hello', notes: '', amount: 0, done: false, status: 'open' }, { strict: true, fieldSelectors })).toBe(5);
    expect(await page.locator('#draft').inputValue()).toBe('hello');
    expect(await page.locator('#notes').inputValue()).toBe('');
    expect(await page.locator('#amount').inputValue()).toBe('0');
    expect(await page.locator('#done').isChecked()).toBe(false);
    expect(await page.locator('#status').inputValue()).toBe('open');
    await expect(fillFormFieldsFromMap(page, 'form', { draft: 'not marked' }, { strict: true })).rejects.toThrow("Expected one field 'draft'");
  });

  it('requires identical selector/value keys before changing a control', async () => {
    await page.setContent('<form><input id="draft" data-field-name="draft" value="original"></form>');
    const maps: Record<string, string>[] = [{}, { other: '#draft' }, { draft: '#draft', extra: '#draft' }];
    for (const fieldSelectors of maps) {
      await expect(fillFormFieldsFromMap(page, 'form', { draft: 'changed' }, { strict: true, fieldSelectors })).rejects.toThrow('keys');
      expect(await page.locator('#draft').inputValue()).toBe('original');
    }
  });

  it('rejects missing, ambiguous, hidden, disabled and non-native explicit targets', async () => {
    await page.setContent('<form><input class="dup"><input class="dup"><input id="hidden" hidden><input id="disabled" disabled><div id="editable" contenteditable="true">text</div><button id="button">Save</button><input id="readonly" readonly><input id="submit" type="submit"></form>');
    for (const selector of ['#missing', '.dup', '#hidden', '#disabled', '#editable', '#button', '#readonly', '#submit', ' ']) {
      await expect(fillFormFieldsFromMap(page, 'form', { draft: 'x' }, { strict: true, fieldSelectors: { draft: selector } })).rejects.toThrow();
    }
  });

  it('retains strict selector value validation without choosing substitutes', async () => {
    await page.setContent('<form><input id="done" type="checkbox"><select id="status"><option value="open">Open</option></select><input id="draft"></form>');
    await expect(fillFormFieldsFromMap(page, 'form', { done: 'true' }, { strict: true, fieldSelectors: { done: '#done' } })).rejects.toThrow('boolean');
    await expect(fillFormFieldsFromMap(page, 'form', { status: 'missing' }, { strict: true, fieldSelectors: { status: '#status' } })).rejects.toThrow('no option');
    await expect(fillFormFieldsFromMap(page, 'form', { draft: {} }, { strict: true, fieldSelectors: { draft: '#draft' } })).rejects.toThrow('unsupported');
  });

  it('retains existing non-strict date coercion with explicit selectors', async () => {
    await page.setContent('<form><input id="date" type="date" data-field-name="date"></form>');
    const values = { date: '2026-10-08T12:30:00.000Z' };
    expect(await fillFormFieldsFromMap(page, 'form', values)).toBe(1);
    expect(await page.locator('#date').inputValue()).toBe('2026-10-08');
    await page.locator('#date').fill('');
    expect(await fillFormFieldsFromMap(page, 'form', values, { fieldSelectors: { date: '#date' } })).toBe(1);
    expect(await page.locator('#date').inputValue()).toBe('2026-10-08');
    await expect(fillFormFieldsFromMap(page, 'form', values, { fieldSelectors: { date: 'form' } })).rejects.toThrow();
  });

  it('returns null when capture fails, and a path only for a saved image', async () => {
    await page.setContent('<main>Evidence</main>');
    const failed = join(dir, 'failed.png');
    vi.spyOn(page, 'screenshot').mockRejectedValueOnce(new Error('capture failed'));
    expect(await takeScreenshot(page, failed)).toBeNull();
    expect(existsSync(failed)).toBe(false);
    const saved = join(dir, 'saved.png');
    expect(await takeScreenshot(page, saved)).toBe(saved);
    expect(existsSync(saved)).toBe(true);
  });
});
