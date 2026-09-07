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
  EntityRow,
  EventPayload,
  RawUserClaims,
  ServerResponseTrace,
} from '@almadar/core';
import type { ConsoleCollector } from '../../browser/console.js';
import type { Driver, DomTriggerResult, DriverContext, SendResult, SnapshotResult } from '../types.js';
import type { ExtendedWalkStep } from '../../planner/types.js';
import { createDefaultSnapshot } from '../helpers/default-snapshot.js';
import { createDefaultDomTrigger } from '../helpers/default-dom-trigger.js';
import { dispatchInBrowser } from '../helpers/browser-send-event.js';
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
  sendEvent?(
    page: Page,
    event: string,
    payload: EventPayload,
    traitScope?: string,
  ): Promise<SendResult>;
  /**
   * Read the current state for a trait. Default reads
   * `window.__orbitalVerification.getTraitState(name)`.
   */
  getState?(page: Page, traitName: string): Promise<string | null>;
  /**
   * Reset the runtime to a hermetic per-step starting state. The
   * kernel passes the dispatching trait's owning-page `route` (e.g.
   * `/deals` for DealBrowse) so the bridge can navigate to the
   * correct page before each step. Without this, every step reverts
   * to `baseUrl` (the index route) and sub-traits / non-default-orbital
   * traits get walked on the wrong page — their `*View` components
   * aren't mounted there, so the test exercises nothing real.
   */
  reset?(page: Page, route?: string): Promise<void>;
  /**
   * Per-trait setup. Default: navigate to `trait.route` if defined.
   */
  beforeTrait?(page: Page, trait: TraitWalkConfig): Promise<void>;
  /**
   * Settle hook between sendEvent and snapshot. Default: 800ms wait.
   */
  settle?(page: Page): Promise<void>;
  /**
   * C1-V9 item A: read the app's currently-bound persona. No generic
   * default — a page has no standard "who am I" query, only whatever
   * HTTP endpoint the consuming tool's runtime exposes (e.g. the
   * playground's `GET /api/orbitals/persona`). Absent = the driver
   * doesn't expose `getPersona` at all, and `tick()`'s `viewerRequirement`
   * steps fail closed instead of switching blind.
   */
  getPersona?(page: Page): Promise<RawUserClaims | null>;
  /**
   * C1-V9 item A: switch the app's bound persona for every subsequent
   * dispatch. No generic default, same reasoning as `getPersona`.
   */
  setPersona?(page: Page, persona: RawUserClaims | null): Promise<void>;
  /**
   * C1-V12: the FULL row set for `entityName` in the runtime's
   * server-truth mock store — no generic default (a page has no standard
   * "list this entity" query, only whatever HTTP endpoint the consuming
   * tool's runtime exposes, e.g. the playground's
   * `GET /api/orbitals/:orbital/entities/:entityType`). Absent =
   * `tick()` falls back to the browser-snapshot-only row picker.
   */
  listEntityRows?(page: Page, entityName: string): Promise<EntityRow[]>;
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

  const driver: Driver<PlaywrightDriverContext> = {
    async sendEvent(ctx, event, payload, traitScope): Promise<SendResult> {
      if (bridge.sendEvent !== undefined) {
        return bridge.sendEvent(ctx.page, event, payload, traitScope);
      }
      const sent = await dispatchInBrowser(ctx.page, event, payload, traitScope);
      const serverResponse: ServerResponseTrace | null = null;
      return { sent, serverResponse };
    },

    async getState(ctx, traitName) {
      if (bridge.getState !== undefined) {
        return bridge.getState(ctx.page, traitName);
      }
      return ctx.page.evaluate(
        (name) => {
          // Core's OrbitalVerificationAPI contract: getTraitState returns
          // `string | undefined` (the current state name).
          const api = (window as Window & { __orbitalVerification?: import('@almadar/core').OrbitalVerificationAPI }).__orbitalVerification;
          const raw = api?.getTraitState?.(name);
          return typeof raw === 'string' ? raw : null;
        },
        traitName,
      );
    },

    async triggerDOM(ctx, step: ExtendedWalkStep, traitScope?: string): Promise<DomTriggerResult> {
      return domTriggerImpl(ctx.page, step, traitScope);
    },

    async snapshot(ctx, step): Promise<SnapshotResult> {
      const result = await snapshotImpl(ctx.page, ctx.outputDir, ctx.trait.traitName, step);
      return result;
    },

    async reset(ctx) {
      // Forward the dispatching trait's route so the bridge can land on
      // the right page. `ctx.trait.route` is populated by
      // `extractTraitWalkConfigs` (`findRouteForTrait` ?? `findDefaultRoute`),
      // so every trait knows its owning orbital's page. Without this,
      // sub-traits / non-default-orbital traits get tested on `/`.
      const route = ctx.trait?.route;
      if (bridge.reset !== undefined) {
        return bridge.reset(ctx.page, route);
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

  // C1-V9 item A: only present on the returned Driver when the consumer
  // actually wired a bridge — `tick()` treats an absent `setPersona` as
  // "this driver can't switch personas" and fails `viewerRequirement`
  // steps closed instead of silently no-op-ing under the wrong viewer.
  if (bridge.getPersona !== undefined) {
    driver.getPersona = async (ctx) => bridge.getPersona!(ctx.page);
  }
  if (bridge.setPersona !== undefined) {
    driver.setPersona = async (ctx, persona) => bridge.setPersona!(ctx.page, persona);
  }
  if (bridge.listEntityRows !== undefined) {
    driver.listEntityRows = async (ctx, entityName) => bridge.listEntityRows!(ctx.page, entityName);
  }

  return driver;
}
