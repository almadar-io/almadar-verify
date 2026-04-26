/**
 * `createPlaywrightDriver` — first-party Driver impl for Playwright.
 *
 * Composes `createDefaultSnapshot` + `createDefaultDomTrigger` and
 * provides the four glue methods (`sendEvent`, `getState`, `reset`,
 * `settle`) plus an optional `beforeTrait` hook. Consumers wire
 * tool-specific bridge details (e.g. how `sendEvent` reaches the
 * runtime, what `reset` does in their world) via the `bridge` callbacks
 * — the helpers above handle every other observation.
 *
 * This is one of the only files in the package that imports
 * `playwright` (the others are `helpers/default-snapshot.ts` and
 * `helpers/default-dom-trigger.ts`). The kernel never names Playwright.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type {
  EventPayload,
  ServerResponseTrace,
} from '@almadar/core';
import type { ConsoleCollector } from '../../browser/console.js';
import type { Driver, DriverContext, SendResult, SnapshotResult } from '../types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';
import { createDefaultSnapshot } from '../helpers/default-snapshot.js';
import { createDefaultDomTrigger } from '../helpers/default-dom-trigger.js';
import type { TraitWalkConfig } from '../../engine/types.js';

/** What the Playwright Driver carries on its context. */
export interface PlaywrightDriverContext extends DriverContext {
  page: Page;
}

/**
 * Tool-specific bridge callbacks. Consumers supply these to wire the
 * Driver to their runtime (compiled-shell `__orbitalVerification`,
 * playground bridge, etc.).
 */
export interface PlaywrightBridge {
  /**
   * Dispatch an event into the runtime. The default impl uses
   * `page.evaluate(() => window.__orbitalVerification.sendEvent(ev, pl))`;
   * consumers can override to add tool-specific cascade capture, etc.
   */
  sendEvent?(page: Page, event: string, payload: EventPayload): Promise<SendResult>;
  /**
   * Read the current state for a trait. Default reads
   * `window.__orbitalVerification.getTraitState(name)`.
   */
  getState?(page: Page, traitName: string): Promise<string | null>;
  /**
   * Reset the runtime. Default: page reload + waitForRuntime.
   */
  reset?(page: Page): Promise<void>;
  /**
   * Per-trait setup. Default: navigate to `trait.route` if defined.
   */
  beforeTrait?(page: Page, trait: TraitWalkConfig): Promise<void>;
  /**
   * Settle hook between sendEvent and snapshot. Default: 800ms wait.
   */
  settle?(page: Page): Promise<void>;
}

export interface CreatePlaywrightDriverOptions {
  /** Tool-specific bridge callbacks (override defaults). */
  bridge?: PlaywrightBridge;
  /** ConsoleCollector bound to the Page; used by `snapshot`. */
  console: ConsoleCollector;
  /** Whether to capture screenshots. Default: true. */
  screenshots?: boolean;
}

export function createPlaywrightDriver(
  options: CreatePlaywrightDriverOptions,
): Driver<PlaywrightDriverContext> {
  const { bridge = {}, console: consoleCollector, screenshots = true } = options;

  const snapshotImpl = createDefaultSnapshot({
    console: consoleCollector,
    screenshots,
  });
  const domTriggerImpl = createDefaultDomTrigger();

  return {
    async sendEvent(ctx, event, payload): Promise<SendResult> {
      if (bridge.sendEvent !== undefined) {
        return bridge.sendEvent(ctx.page, event, payload);
      }
      const sent = await dispatchInBrowser(ctx.page, event, payload);
      const serverResponse: ServerResponseTrace | null = null;
      return { sent, serverResponse };
    },

    async getState(ctx, traitName) {
      if (bridge.getState !== undefined) {
        return bridge.getState(ctx.page, traitName);
      }
      return ctx.page.evaluate(
        (name) => {
          const api = (window as unknown as { __orbitalVerification?: { getTraitState?: (n: string) => unknown } }).__orbitalVerification;
          const raw = api?.getTraitState?.(name);
          if (typeof raw === 'string') return raw;
          if (raw !== null && typeof raw === 'object') {
            const obj = raw as { currentState?: unknown; name?: unknown };
            if (typeof obj.currentState === 'string') return obj.currentState;
            if (typeof obj.name === 'string') return obj.name;
          }
          return null;
        },
        traitName,
      );
    },

    async triggerDOM(ctx, step: ExtendedWalkStep): Promise<boolean> {
      return domTriggerImpl(ctx.page, step);
    },

    async snapshot(ctx, step): Promise<SnapshotResult> {
      const result = await snapshotImpl(ctx.page, ctx.outputDir, ctx.trait.traitName, step);
      return result;
    },

    async reset(ctx) {
      if (bridge.reset !== undefined) {
        return bridge.reset(ctx.page);
      }
      await ctx.page.reload();
    },

    async settle(ctx) {
      if (bridge.settle !== undefined) {
        return bridge.settle(ctx.page);
      }
      await ctx.page.waitForTimeout(800);
    },

    async beforeTrait(ctx) {
      if (bridge.beforeTrait !== undefined) {
        return bridge.beforeTrait(ctx.page, ctx.trait);
      }
      // No default — tool decides routing.
    },
  };
}

// ── internal: extracted to top-level so TS doesn't re-infer the
// page.evaluate callback signature through Playwright's overload
// chain on every call site (which trips the "excessively deep" check).

async function dispatchInBrowser(page: Page, event: string, payload: EventPayload): Promise<boolean> {
  // page.evaluate's `arg` parameter wants a serializable type.
  // EventPayload is recursively-typed (values can be EventPayload),
  // which trips Playwright's overload inference into "excessively
  // deep" depth-bounded recursion. We project the args into a plain
  // record at the boundary to break the inference chain — the runtime
  // payload IS still EventPayload-shaped, the cast is purely a TS
  // erasure to avoid the overload explosion.
  const args = { ev: event, pl: payload as unknown as Record<string, unknown> };
  const result = await page.evaluate(browserSendEvent, args);
  return result === true;
}

function browserSendEvent(a: { ev: string; pl: Record<string, unknown> }): boolean {
  const api = (window as unknown as { __orbitalVerification?: { sendEvent?: (e: string, p?: Record<string, unknown>) => void } }).__orbitalVerification;
  if (api?.sendEvent === undefined) return false;
  api.sendEvent(a.ev, a.pl);
  return true;
}
