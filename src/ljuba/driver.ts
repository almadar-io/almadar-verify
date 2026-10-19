import type {
  Driver,
  DriverContext,
  SendResult,
  SnapshotResult,
  ExtendedWalkStep,
  TraitWalkConfig,
} from '../browser.js';
import type {
  EffectTrace,
  EntityData,
  EventLogEntry,
  ServerResponseTrace,
  VerificationSnapshot,
  EventPayload,
  TraitConfig,
} from '@almadar/core';
import { LjubaPage } from './page.js';


/** Context carried by the Ljuba driver. */
export interface LjubaDriverContext extends DriverContext {
  page: LjubaPage;
}

/** Build a Driver implementation backed by LjubaPage. */
export function createLjubaDriver(): Driver<LjubaDriverContext> {
  return {
    async sendEvent(ctx, event, payload, traitScope): Promise<SendResult> {
      const sent = await ctx.page.evaluate(() => {
        const api = window.__orbitalVerification;
        if (api?.sendEvent === undefined) return false;
        api.sendEvent(event, payload, traitScope);
        return true;
      });
      return { sent, serverResponse: null };
    },

    async getState(_ctx: LjubaDriverContext, traitName: string): Promise<string | null> {
      return _ctx.page.evaluate(() => {
        const api = window.__orbitalVerification;
        const declared = api?.getTraitState?.(traitName);
        if (declared !== undefined) return declared;
        const snap = api?.getSnapshot();
        return snap?.traits.find((t) => t.traitName === traitName)?.currentState ?? null;
      });
    },

    async triggerDOM(ctx: LjubaDriverContext, step: ExtendedWalkStep): Promise<boolean> {
      const affordanceEvent = step.openAffordanceEvent ?? step.event;
      const baseSelector = `[data-testid="action-${affordanceEvent}"]`;
      const selector =
        step.targetRowId !== undefined
          ? `${baseSelector}[data-row-id="${step.targetRowId}"]`
          : baseSelector;

      const locator = ctx.page.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 250 });
      if (!visible) return false;

      await locator.click();

      // Form fill
      if (step.formData !== undefined && Object.keys(step.formData).length > 0) {
        await ctx.page.waitForTimeout(600);
        for (const [key, value] of Object.entries(step.formData)) {
          const fieldLocator = ctx.page.locator(`[data-field-name="${key}"] input, [data-field-name="${key}"] textarea, [data-field-name="${key}"] select`).first();
          const fieldVisible = await fieldLocator.isVisible({ timeout: 500 });
          if (fieldVisible) {
            await fieldLocator.fill(String(value));
          }
        }
      }

      return true;
    },

    async snapshot(ctx: LjubaDriverContext, step: ExtendedWalkStep | null): Promise<SnapshotResult> {
      const runtimeSnapshot =
        (await ctx.page.evaluate(() => {
          const api = window.__orbitalVerification;
          return api?.getSnapshot() ?? null;
        })) ?? emptySnapshot();

      const entityData = mergeEntityData(runtimeSnapshot);

      const portals = await ctx.page.evaluate(() => {
        const slots = ['main', 'header', 'footer', 'sidebar', 'modal', 'overlay', 'floating'];
        return slots.map((name) => {
          const el = document.getElementById(`slot-${name}`);
          if (el === null) return { slot: name, mounted: false, childCount: 0 };
          return { slot: name, mounted: true, childCount: el.children.length };
        });
      }) as SnapshotResult['dom']['portals'];

      let screenshotPath: string | null = null;
      if (step !== null) {
        try {
          const bytes = await ctx.page.screenshot();
          const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' });
          screenshotPath = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        } catch {
          /* screenshot disabled or html2canvas missing */
        }
      }

      const effectResults = lastEffectResultsFor(runtimeSnapshot, ctx.trait.traitName);
      const serverResponse = lastServerResponseFor(runtimeSnapshot, ctx.trait.traitName, step?.event);

      return {
        runtimeSnapshot,
        dom: {
          url: typeof window !== 'undefined' ? window.location.href : '',
          rowsByEntity: rowCounts(entityData),
          portals,
          visibleTextSample: '',
        },
        consoleAdded: [],
        eventLogAdded: [],
        effectResults,
        serverResponse,
        entityData,
        screenshotPath,
      };
    },

    async reset(ctx: LjubaDriverContext): Promise<void> {
      const route = ctx.trait?.route;
      if (route !== undefined && route !== null && route !== '') {
        await ctx.page.goto(route);
      }
      await ctx.page.waitForTimeout(400);
    },

    async settle(ctx: LjubaDriverContext): Promise<void> {
      await ctx.page.waitForTimeout(800);
    },

    async beforeTrait(ctx: LjubaDriverContext): Promise<void> {
      const route = ctx.trait?.route;
      if (route !== undefined && route !== null && route !== '') {
        await ctx.page.goto(route);
      }
      await ctx.page.waitForTimeout(400);
    },

    async applyConfig(ctx: LjubaDriverContext, traitName: string, config: TraitConfig): Promise<void> {
      // The playground registers `applyConfig` on the bridge: it POSTs the override,
      // re-registers the schema and re-renders. `evaluate` runs in-process, so the
      // closure captures `traitName`/`config` directly.
      await ctx.page.evaluate(() => {
        const api = window.__orbitalVerification;
        return api?.applyConfig?.(traitName, config);
      });
      await ctx.page.waitForTimeout(600);
    },
  };
}

// ── ljuba-local snapshot helpers (verify does not export these) ────

function emptySnapshot(): VerificationSnapshot {
  return {
    checks: [],
    transitions: [],
    bridge: null,
    summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
    traits: [],
  };
}

function mergeEntityData(snap: VerificationSnapshot): EntityData {
  const latestFetchTraitByEntity: Record<string, { traitName: string; ts: number }> = {};
  for (const tx of snap.transitions) {
    const sr = tx.serverResponse;
    if (sr === undefined) continue;
    const fetchedNames = Object.keys(sr.dataEntities ?? {});
    if (fetchedNames.length === 0) continue;
    const hasFetchEffect = (tx.effects ?? []).some((e: { type?: string }) => e.type === 'fetch');
    if (!hasFetchEffect) continue;
    for (const name of fetchedNames) {
      const current = latestFetchTraitByEntity[name];
      if (current === undefined || (tx.timestamp ?? 0) > current.ts) {
        latestFetchTraitByEntity[name] = { traitName: tx.traitName, ts: tx.timestamp ?? 0 };
      }
    }
  }
  const out: EntityData = {};
  for (const trait of snap.traits) {
    const traitData = (trait.data ?? {}) as EntityData;
    for (const [name, rows] of Object.entries(traitData)) {
      const winner = latestFetchTraitByEntity[name];
      if (winner === undefined) {
        out[name] = rows;
      } else if (winner.traitName === trait.traitName) {
        out[name] = rows;
      }
    }
  }
  return out;
}

function rowCounts(data: EntityData): { [name: string]: number } {
  const out: { [name: string]: number } = {};
  for (const [name, rows] of Object.entries(data)) {
    out[name] = rows.length;
  }
  return out;
}

function lastEffectResultsFor(snap: VerificationSnapshot, traitName: string): EffectTrace[] {
  const recent = [...snap.transitions].reverse().find((t) => t.traitName === traitName);
  return recent?.effects ?? [];
}

function lastServerResponseFor(
  snap: VerificationSnapshot,
  traitName: string,
  event?: string,
): ServerResponseTrace | null {
  const reversed = [...snap.transitions].reverse();
  const traitMatch = reversed.find((t) => t.traitName === traitName && t.serverResponse !== undefined);
  if (traitMatch?.serverResponse) return traitMatch.serverResponse;
  if (event !== undefined) {
    const serverMatch = reversed.find(
      (t) => t.traitName.startsWith('server:') && t.event === event && t.serverResponse !== undefined,
    );
    if (serverMatch?.serverResponse) return serverMatch.serverResponse;
  }
  return null;
}
