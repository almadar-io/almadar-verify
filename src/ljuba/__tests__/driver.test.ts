// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LjubaBrowser } from '../browser.js';
import { createLjubaDriver } from '../driver.js';
import type { LjubaDriverContext } from '../driver.js';
import type { ExtendedWalkStep, TraitWalkConfig } from '../../browser.js';
import { traitSnapshot, verificationBridge, type SentEvent } from './bridge.js';

describe('createLjubaDriver', () => {
  let container: HTMLDivElement;
  let ctx: LjubaDriverContext;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);

    const browser = await LjubaBrowser.launch(container);
    const context = await browser.newContext();
    const page = await context.newPage();

    const trait: TraitWalkConfig = {
      traitName: 'TestTrait',
      initialState: 'idle',
      events: [{ key: 'OPEN', name: 'Open' }, { key: 'CLOSE', name: 'Close' }],
      transitions: [{ from: 'idle', to: 'open', event: 'OPEN', hasGuard: false }],
      route: '/test',
    };

    ctx = { page, outputDir: '', trait };
  });

  afterEach(() => {
    container.remove();
    delete window.__orbitalVerification;
  });

  it('returns a Driver with all required methods', () => {
    const driver = createLjubaDriver();
    expect(typeof driver.sendEvent).toBe('function');
    expect(typeof driver.getState).toBe('function');
    expect(typeof driver.triggerDOM).toBe('function');
    expect(typeof driver.snapshot).toBe('function');
    expect(typeof driver.reset).toBe('function');
    expect(typeof driver.settle).toBe('function');
    expect(typeof driver.beforeTrait).toBe('function');
  });

  it('sendEvent dispatches via window.__orbitalVerification', async () => {
    const sent: SentEvent[] = [];
    window.__orbitalVerification = verificationBridge([], sent);

    const driver = createLjubaDriver();
    const result = await driver.sendEvent(ctx, 'OPEN', { id: '1' }, 'TestOrbital.TestTrait');

    expect(result.sent).toBe(true);
    expect(sent).toEqual([{ event: 'OPEN', payload: { id: '1' }, traitScope: 'TestOrbital.TestTrait' }]);
  });

  it('getState reads currentState from snapshot', async () => {
    window.__orbitalVerification = verificationBridge([traitSnapshot('TestTrait', 'open')]);

    const driver = createLjubaDriver();
    const state = await driver.getState(ctx, 'TestTrait');
    expect(state).toBe('open');
  });

  it('triggerDOM clicks a visible [data-testid] element', async () => {
    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'action-OPEN');
    const clickSpy = vi.fn();
    btn.addEventListener('click', clickSpy);
    container.appendChild(btn);

    const driver = createLjubaDriver();
    const step: ExtendedWalkStep = {
      from: 'idle',
      to: 'open',
      event: 'OPEN',
      coverageKey: 'TestTrait:idle+OPEN->open',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      triggerKind: 'dom',
      traitName: 'TestTrait',
    };

    const result = await driver.triggerDOM(ctx, step);
    expect(result).toBe(true);
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it('triggerDOM returns false when element is missing', async () => {
    const driver = createLjubaDriver();
    const step: ExtendedWalkStep = {
      from: 'idle',
      to: 'open',
      event: 'MISSING',
      coverageKey: 'TestTrait:idle+MISSING->open',
      guardCase: null,
      payload: {},
      isRepositioning: false,
      triggerKind: 'dom',
      traitName: 'TestTrait',
    };

    const result = await driver.triggerDOM(ctx, step);
    expect(result).toBe(false);
  });

  it('snapshot returns runtime data from window.__orbitalVerification', async () => {
    window.__orbitalVerification = verificationBridge([traitSnapshot('TestTrait', 'idle')]);

    const driver = createLjubaDriver();
    const snap = await driver.snapshot(ctx, null);

    expect(snap.runtimeSnapshot.traits[0].currentState).toBe('idle');
    expect(snap.dom.portals.length).toBeGreaterThan(0);
    expect(snap.consoleAdded).toEqual([]);
    expect(snap.eventLogAdded).toEqual([]);
  });

  it('settle waits at least 700ms', async () => {
    const driver = createLjubaDriver();
    const start = Date.now();
    await driver.settle(ctx);
    expect(Date.now() - start).toBeGreaterThanOrEqual(700);
  });
});
