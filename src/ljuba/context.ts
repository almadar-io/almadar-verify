import { LjubaPage } from './page.js';
import type { LjubaLaunchOptions } from './types.js';

/**
 * LjubaContext manages a browsing context within the Studio container.
 * Mirrors Playwright's BrowserContext API.
 */
export class LjubaContext {
  private container: HTMLElement;
  private options: LjubaLaunchOptions;

  constructor(container: HTMLElement, options?: LjubaLaunchOptions) {
    this.container = container;
    this.options = options ?? {};
  }

  async newPage(): Promise<LjubaPage> {
    void this.options;
    return new LjubaPage(this.container);
  }

  async close(): Promise<void> {
    // no-op: we don't own the browser context
  }
}
