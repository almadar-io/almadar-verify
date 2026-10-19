import type { EventPayload } from '@almadar/core';
import type { LjubaPage } from './page.js';

interface VerificationStep {
  event?: string;
}

/**
 * LjubaEngineAdapter bridges verification steps to the OrbPreview runtime.
 * Uses the __orbitalVerification bridge that OrbPreview exposes on window.
 * The canonical walk contract is `Driver<Ctx>` (`@almadar-io/verify/browser`,
 * see `createLjubaDriver`); verify's legacy `EngineAdapter` was removed in v2.0.0.
 */
export class LjubaEngineAdapter {
  async sendEvent(
    page: LjubaPage,
    event: string,
    payload: EventPayload
  ): Promise<boolean> {
    return page.evaluate(() => {
      const send = window.__orbitalVerification?.sendEvent;
      if (send === undefined) return false;
      send(event, payload);
      return true;
    });
  }

  async getState(
    page: LjubaPage,
    traitName: string
  ): Promise<string | null> {
    return page.evaluate(() => {
      const bridge = window.__orbitalVerification;
      if (bridge === undefined) return null;
      return bridge.getSnapshot().traits.find((t) => t.traitName === traitName)?.currentState ?? null;
    });
  }

  async settle(page: LjubaPage): Promise<void> {
    await page.waitForTimeout(300);
  }

  async triggerViaDOM(
    page: LjubaPage,
    step: unknown,
    _traitName: string
  ): Promise<boolean> {
    const s = step as VerificationStep;
    if (!s.event) return false;
    const locator = page.locator(`[data-event="${s.event}"]`);
    const count = await locator.count();
    if (count === 0) return false;
    await locator.first().click();
    return true;
  }
}
