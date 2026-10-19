// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LjubaBrowser } from '../browser.js';
import { LjubaPage } from '../page.js';
import { LjubaEngineAdapter } from '../engine-adapter.js';
import { traitSnapshot as trait, verificationBridge as bridge, type SentEvent } from './bridge.js';

/**
 * Helper: build a container div with child elements for testing.
 * Returns the container and its children for assertion.
 */
function buildContainer(): HTMLDivElement {
  const container = document.createElement('div');

  const btn1 = document.createElement('button');
  btn1.setAttribute('data-event', 'CREATE');
  btn1.setAttribute('data-pattern', 'action-button');
  btn1.textContent = 'Create Item';
  container.appendChild(btn1);

  const btn2 = document.createElement('button');
  btn2.setAttribute('data-event', 'DELETE');
  btn2.setAttribute('data-pattern', 'action-button');
  btn2.textContent = 'Delete Item';
  container.appendChild(btn2);

  const input = document.createElement('input');
  input.setAttribute('data-event', 'INPUT_NAME');
  input.setAttribute('type', 'text');
  input.setAttribute('placeholder', 'Enter name');
  container.appendChild(input);

  const span = document.createElement('span');
  span.setAttribute('data-pattern', 'label');
  span.textContent = 'Status: active';
  container.appendChild(span);

  return container;
}

// ---------------------------------------------------------------------------
// LjubaBrowser
// ---------------------------------------------------------------------------
describe('LjubaBrowser', () => {
  it('launch() returns a LjubaBrowser instance', async () => {
    const container = buildContainer();
    const browser = await LjubaBrowser.launch(container);
    expect(browser).toBeDefined();
  });

  it('newContext() returns a context', async () => {
    const container = buildContainer();
    const browser = await LjubaBrowser.launch(container);
    const context = await browser.newContext();
    expect(context).toBeDefined();
  });

  it('context.newPage() returns a page', async () => {
    const container = buildContainer();
    const browser = await LjubaBrowser.launch(container);
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(page).toBeDefined();
    expect(page).toBeInstanceOf(LjubaPage);
  });

  it('close() resolves without error', async () => {
    const container = buildContainer();
    const browser = await LjubaBrowser.launch(container);
    await expect(browser.close()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LjubaPage.locator + LjubaLocator
// ---------------------------------------------------------------------------
describe('LjubaLocator', () => {
  let page: LjubaPage;

  beforeEach(async () => {
    const container = buildContainer();
    const browser = await LjubaBrowser.launch(container);
    const context = await browser.newContext();
    page = await context.newPage();
  });

  it('locator finds elements by data-event attribute', async () => {
    const loc = page.locator('[data-event="CREATE"]');
    expect(await loc.count()).toBe(1);
  });

  it('locator finds multiple elements by data-pattern', async () => {
    const loc = page.locator('[data-pattern="action-button"]');
    expect(await loc.count()).toBe(2);
  });

  it('count() returns 0 for non-matching selector', async () => {
    const loc = page.locator('[data-event="NONEXISTENT"]');
    expect(await loc.count()).toBe(0);
  });

  it('click() calls the element click handler', async () => {
    const clickSpy = vi.fn();
    const container = document.createElement('div');
    const btn = document.createElement('button');
    btn.setAttribute('data-event', 'SAVE');
    btn.addEventListener('click', clickSpy);
    container.appendChild(btn);

    const p = new LjubaPage(container);
    await p.locator('[data-event="SAVE"]').click();
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('click() throws when no element matches', async () => {
    await expect(
      page.locator('[data-event="MISSING"]').click()
    ).rejects.toThrow('No element found');
  });

  it('fill() sets input value and dispatches input+change events', async () => {
    const container = document.createElement('div');
    const input = document.createElement('input');
    input.setAttribute('data-field', 'name');
    container.appendChild(input);

    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    input.addEventListener('input', inputSpy);
    input.addEventListener('change', changeSpy);

    const p = new LjubaPage(container);
    await p.locator('[data-field="name"]').fill('hello world');

    expect(input.value).toBe('hello world');
    expect(inputSpy).toHaveBeenCalledOnce();
    expect(changeSpy).toHaveBeenCalledOnce();
  });

  it('fill() throws when no element matches', async () => {
    await expect(
      page.locator('[data-field="missing"]').fill('value')
    ).rejects.toThrow('No element found');
  });

  it('getAttribute() returns attribute value', async () => {
    const loc = page.locator('[data-event="CREATE"]');
    expect(await loc.getAttribute('data-event')).toBe('CREATE');
    expect(await loc.getAttribute('data-pattern')).toBe('action-button');
  });

  it('getAttribute() returns null for missing attribute', async () => {
    const loc = page.locator('[data-event="CREATE"]');
    expect(await loc.getAttribute('data-nonexistent')).toBeNull();
  });

  it('getAttribute() returns null when no element matches', async () => {
    const loc = page.locator('[data-event="NOPE"]');
    expect(await loc.getAttribute('data-event')).toBeNull();
  });

  it('textContent() returns element text', async () => {
    const loc = page.locator('[data-event="CREATE"]');
    expect(await loc.textContent()).toBe('Create Item');
  });

  it('textContent() returns null when no element matches', async () => {
    const loc = page.locator('[data-event="NOPE"]');
    expect(await loc.textContent()).toBeNull();
  });

  it('first() returns a single-element locator', async () => {
    const loc = page.locator('[data-pattern="action-button"]');
    const first = loc.first();
    expect(await first.count()).toBe(1);
    expect(await first.textContent()).toBe('Create Item');
  });

  it('nth() returns the element at the given index', async () => {
    const loc = page.locator('[data-pattern="action-button"]');
    const second = loc.nth(1);
    expect(await second.textContent()).toBe('Delete Item');
  });

  it('allTextContents() returns all text values', async () => {
    const loc = page.locator('[data-pattern="action-button"]');
    const texts = await loc.allTextContents();
    expect(texts).toEqual(['Create Item', 'Delete Item']);
  });

  it('isVisible() returns true when element exists', async () => {
    const loc = page.locator('[data-event="CREATE"]');
    expect(await loc.isVisible()).toBe(true);
  });

  it('isVisible() returns false when element does not exist', async () => {
    const loc = page.locator('[data-event="NOPE"]');
    expect(await loc.isVisible()).toBe(false);
  });

  it('hover() dispatches mouseenter', async () => {
    const container = document.createElement('div');
    const el = document.createElement('div');
    el.setAttribute('data-test', 'hover-target');
    const hoverSpy = vi.fn();
    el.addEventListener('mouseenter', hoverSpy);
    container.appendChild(el);

    const p = new LjubaPage(container);
    await p.locator('[data-test="hover-target"]').hover();
    expect(hoverSpy).toHaveBeenCalledOnce();
  });

  it('press() dispatches keydown event', async () => {
    const container = document.createElement('div');
    const el = document.createElement('input');
    el.setAttribute('data-test', 'key-target');
    const keySpy = vi.fn();
    el.addEventListener('keydown', keySpy);
    container.appendChild(el);

    const p = new LjubaPage(container);
    await p.locator('[data-test="key-target"]').press('Enter');
    expect(keySpy).toHaveBeenCalledOnce();
    expect(keySpy.mock.calls[0][0].key).toBe('Enter');
  });

  it('selectOption() sets value and dispatches change', async () => {
    const container = document.createElement('div');
    const select = document.createElement('select');
    select.setAttribute('data-test', 'select-target');
    const opt1 = document.createElement('option');
    opt1.value = 'a';
    opt1.textContent = 'Option A';
    const opt2 = document.createElement('option');
    opt2.value = 'b';
    opt2.textContent = 'Option B';
    select.appendChild(opt1);
    select.appendChild(opt2);
    container.appendChild(select);

    const changeSpy = vi.fn();
    select.addEventListener('change', changeSpy);

    const p = new LjubaPage(container);
    await p.locator('[data-test="select-target"]').selectOption('b');
    expect(select.value).toBe('b');
    expect(changeSpy).toHaveBeenCalledOnce();
  });

  it('isEditable() returns true for enabled input', async () => {
    const container = document.createElement('div');
    const input = document.createElement('input');
    input.setAttribute('data-test', 'edit');
    container.appendChild(input);

    const p = new LjubaPage(container);
    expect(await p.locator('[data-test="edit"]').isEditable()).toBe(true);
  });

  it('isEditable() returns false for disabled input', async () => {
    const container = document.createElement('div');
    const input = document.createElement('input');
    input.setAttribute('data-test', 'edit');
    input.disabled = true;
    container.appendChild(input);

    const p = new LjubaPage(container);
    expect(await p.locator('[data-test="edit"]').isEditable()).toBe(false);
  });

  it('isEnabled() returns false for disabled button', async () => {
    const container = document.createElement('div');
    const btn = document.createElement('button');
    btn.setAttribute('data-test', 'btn');
    btn.disabled = true;
    container.appendChild(btn);

    const p = new LjubaPage(container);
    expect(await p.locator('[data-test="btn"]').isEnabled()).toBe(false);
  });

  it('filter({ hasText }) narrows results by text content', async () => {
    const loc = page.locator('[data-pattern="action-button"]');
    const filtered = loc.filter({ hasText: 'Delete' });
    expect(await filtered.count()).toBe(1);
    expect(await filtered.textContent()).toBe('Delete Item');
  });
});

// ---------------------------------------------------------------------------
// LjubaPage
// ---------------------------------------------------------------------------
describe('LjubaPage', () => {
  let container: HTMLDivElement;
  let page: LjubaPage;

  beforeEach(() => {
    container = buildContainer();
    page = new LjubaPage(container);
  });

  it('evaluate() calls the function and returns its result', async () => {
    const result = await page.evaluate(() => 2 + 3);
    expect(result).toBe(5);
  });

  it('evaluate() can return complex values', async () => {
    const result = await page.evaluate(() => ({ key: 'value', n: 42 }));
    expect(result).toEqual({ key: 'value', n: 42 });
  });

  it('waitForSelector resolves when element already exists', async () => {
    await expect(
      page.waitForSelector('[data-event="CREATE"]', { timeout: 200 })
    ).resolves.toBeUndefined();
  });

  it('waitForSelector rejects on timeout when element missing', async () => {
    await expect(
      page.waitForSelector('[data-event="NONEXISTENT"]', { timeout: 100 })
    ).rejects.toThrow('Timeout waiting for selector');
  });

  it('waitForSelector resolves when element appears later', async () => {
    const freshContainer = document.createElement('div');
    const p = new LjubaPage(freshContainer);

    // Add element after 50ms
    setTimeout(() => {
      const el = document.createElement('div');
      el.setAttribute('data-late', 'true');
      freshContainer.appendChild(el);
    }, 50);

    await expect(
      p.waitForSelector('[data-late="true"]', { timeout: 500 })
    ).resolves.toBeUndefined();
  });

  it('goto() dispatches ljuba:navigate custom event', async () => {
    const navSpy = vi.fn();
    container.addEventListener('ljuba:navigate', (e) => {
      navSpy((e as CustomEvent).detail);
    });

    await page.goto('/some/route');
    expect(navSpy).toHaveBeenCalledWith({ url: '/some/route' });
  });

  it('on("console") receives ljuba:console events', () => {
    const handler = vi.fn();
    page.on('console', handler);

    container.dispatchEvent(
      new CustomEvent('ljuba:console', {
        detail: { type: 'warn', text: 'test warning' },
      })
    );

    expect(handler).toHaveBeenCalledOnce();
    const msg = handler.mock.calls[0][0];
    expect(msg.type()).toBe('warn');
    expect(msg.text()).toBe('test warning');
  });

  it('removeListener cleans up console listeners', () => {
    const handler = vi.fn();
    page.on('console', handler);

    // Should fire
    container.dispatchEvent(
      new CustomEvent('ljuba:console', { detail: { type: 'log', text: 'a' } })
    );
    expect(handler).toHaveBeenCalledOnce();

    page.removeListener('console', handler);

    // Should NOT fire after removal
    container.dispatchEvent(
      new CustomEvent('ljuba:console', { detail: { type: 'log', text: 'b' } })
    );
    expect(handler).toHaveBeenCalledOnce(); // still 1
  });
});

// ---------------------------------------------------------------------------
// LjubaEngineAdapter
// ---------------------------------------------------------------------------
describe('LjubaEngineAdapter', () => {
  it('getState reads the named trait from the bridge snapshot', async () => {
    window.__orbitalVerification = bridge([trait('Cart', 'open'), trait('Combat', 'attacking')]);
    const page = new LjubaPage(document.createElement('div'));
    expect(await new LjubaEngineAdapter().getState(page, 'Combat')).toBe('attacking');
    expect(await new LjubaEngineAdapter().getState(page, 'Missing')).toBeNull();
    delete window.__orbitalVerification;
    expect(await new LjubaEngineAdapter().getState(page, 'Combat')).toBeNull();
  });

  it('sendEvent forwards to the bridge and is false without one', async () => {
    const sent: SentEvent[] = [];
    window.__orbitalVerification = bridge([], sent);
    const page = new LjubaPage(document.createElement('div'));
    expect(await new LjubaEngineAdapter().sendEvent(page, 'ATTACK', { power: 3 })).toBe(true);
    expect(sent).toEqual([{ event: 'ATTACK', payload: { power: 3 }, traitScope: undefined }]);
    window.__orbitalVerification = bridge([]);
    expect(await new LjubaEngineAdapter().sendEvent(page, 'ATTACK', {})).toBe(false);
    delete window.__orbitalVerification;
    expect(await new LjubaEngineAdapter().sendEvent(page, 'ATTACK', {})).toBe(false);
  });
  it('triggerViaDOM clicks element matching data-event', async () => {
    const container = document.createElement('div');
    const btn = document.createElement('button');
    btn.setAttribute('data-event', 'ATTACK');
    const clickSpy = vi.fn();
    btn.addEventListener('click', clickSpy);
    container.appendChild(btn);

    const page = new LjubaPage(container);
    const adapter = new LjubaEngineAdapter();

    const result = await adapter.triggerViaDOM(page, { event: 'ATTACK' }, 'combat');
    expect(result).toBe(true);
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('triggerViaDOM returns false when no matching element exists', async () => {
    const container = document.createElement('div');
    const page = new LjubaPage(container);
    const adapter = new LjubaEngineAdapter();

    const result = await adapter.triggerViaDOM(page, { event: 'MISSING' }, 'trait');
    expect(result).toBe(false);
  });

  it('triggerViaDOM returns false when step has no event', async () => {
    const container = document.createElement('div');
    const page = new LjubaPage(container);
    const adapter = new LjubaEngineAdapter();

    const result = await adapter.triggerViaDOM(page, {}, 'trait');
    expect(result).toBe(false);
  });

  it('settle() waits briefly', async () => {
    const container = document.createElement('div');
    const page = new LjubaPage(container);
    const adapter = new LjubaEngineAdapter();

    const start = Date.now();
    await adapter.settle(page);
    const elapsed = Date.now() - start;
    // Should wait approximately 300ms (the waitForTimeout value)
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });
});
