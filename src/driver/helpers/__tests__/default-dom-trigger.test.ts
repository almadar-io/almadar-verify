/**
 * `createDefaultDomTrigger` shell-dismiss fallback — the Modal/Drawer X
 * (`@almadar/ui` Modal.tsx: `data-event="CLOSE"`, no `data-testid`) is
 * invisible to the primary `[data-testid="action-<EVENT>"]` selector.
 * `assertClickNoListener` can only exercise the shell X if `triggerDOM`
 * can find it — see `default-dom-trigger.ts`'s new fallback block.
 *
 * Runs against a REAL (headless) Playwright page rather than a hand-rolled
 * `Page` stub: the package has no existing mock for Playwright's `Page`/
 * `Locator` surface, and building one for this one test would either fake
 * a large interface or require an unsafe cast — a real page exercises the
 * actual `locator().isVisible()/.click()` codepath with no cast at all.
 *
 * @packageDocumentation
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createDefaultDomTrigger, shellDismissSelector } from '../default-dom-trigger.js';
import type { ExtendedWalkStep } from '../../../planner/types.js';

describe('shellDismissSelector', () => {
  it('targets the raw data-event attribute, not a data-testid', () => {
    expect(shellDismissSelector('CLOSE')).toBe('[data-event="CLOSE"]');
    expect(shellDismissSelector('CANCEL')).toBe('[data-event="CANCEL"]');
  });
});

describe('createDefaultDomTrigger — shell dismiss fallback', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser.close();
  });

  const step = (event: string): ExtendedWalkStep => ({
    from: 'open',
    event,
    to: 'idle',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    triggerKind: 'dom',
    coverageKey: `Panel:open+${event}->idle`,
    traitName: 'ChatOverlayPanel',
  });

  it('clicks the Modal shell X (data-event="CLOSE") when no action-CLOSE testid exists', async () => {
    page = await browser.newPage();
    await page.setContent(`
      <button data-event="CLOSE" onclick="window.__dismissed = 'CLOSE'">×</button>
    `);
    const trigger = createDefaultDomTrigger();
    const result = await trigger(page, step('CLOSE'));
    expect(result).toBe(true);
    const dismissed = await page.evaluate(() => (window as Window & { __dismissed?: string }).__dismissed);
    expect(dismissed).toBe('CLOSE');
    await page.close();
  });

  it('clicks a CANCEL shell control the same way', async () => {
    page = await browser.newPage();
    await page.setContent(`
      <button data-event="CANCEL" onclick="window.__dismissed = 'CANCEL'">×</button>
    `);
    const trigger = createDefaultDomTrigger();
    const result = await trigger(page, step('CANCEL'));
    expect(result).toBe(true);
    const dismissed = await page.evaluate(() => (window as Window & { __dismissed?: string }).__dismissed);
    expect(dismissed).toBe('CANCEL');
    await page.close();
  });

  it('prefers the action-testid button over the shell fallback when both exist', async () => {
    page = await browser.newPage();
    await page.setContent(`
      <button data-testid="action-CLOSE" onclick="window.__dismissed = 'testid'">Close</button>
      <button data-event="CLOSE" onclick="window.__dismissed = 'shell'">×</button>
    `);
    const trigger = createDefaultDomTrigger();
    const result = await trigger(page, step('CLOSE'));
    expect(result).toBe(true);
    const dismissed = await page.evaluate(() => (window as Window & { __dismissed?: string }).__dismissed);
    expect(dismissed).toBe('testid');
    await page.close();
  });

  it('returns false when neither an action-testid nor a shell data-event control exists', async () => {
    page = await browser.newPage();
    await page.setContent(`<div>nothing clickable here</div>`);
    const trigger = createDefaultDomTrigger();
    const result = await trigger(page, step('CLOSE'));
    expect(result).toBe(false);
    await page.close();
  });
});

describe('createDefaultDomTrigger — a form\'s own submit affordance', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser.close();
  });

  const submitStep = (payloadCase?: ExtendedWalkStep['payloadCase']): ExtendedWalkStep => ({
    from: 'editing',
    event: 'SUBMIT_KEY',
    to: 'idle',
    guardCase: null,
    payload: {},
    isRepositioning: false,
    triggerKind: 'dom',
    coverageKey: 'Panel:editing+SUBMIT_KEY->idle',
    traitName: 'CredentialPanel',
    testKind: 'interaction',
    ...(payloadCase !== undefined && { payloadCase }),
  });

  const FORM = `
    <div data-pattern="form-section">
      <input name="value" type="password" required />
      <button data-testid="action-SUBMIT_KEY" onclick="window.__submitted = document.querySelector('input[name=value]').value">Save</button>
    </div>
  `;

  it('fills the form before clicking its submit, so the submit carries valid data', async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const result = await createDefaultDomTrigger()(page, submitStep());
    expect(result).toBe(true);
    const submitted = await page.evaluate(() => (window as Window & { __submitted?: string }).__submitted);
    expect(submitted).not.toBe('');
    expect(submitted).toBeDefined();
    await page.close();
  });

  it('control: a malformed-payload probe submits the form as it stands', async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    await createDefaultDomTrigger()(page, submitStep('malformed'));
    const submitted = await page.evaluate(() => (window as Window & { __submitted?: string }).__submitted);
    expect(submitted).toBe('');
    await page.close();
  });

  it('control: an affordance outside any form leaves inputs untouched', async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <input name="search" type="text" />
      <button data-testid="action-SUBMIT_KEY" onclick="window.__submitted = 'clicked'">Go</button>
    `);
    await createDefaultDomTrigger()(page, submitStep());
    expect(await page.inputValue('input[name=search]')).toBe('');
    await page.close();
  });
});
