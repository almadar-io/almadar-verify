import { LjubaContext } from './context.js';
import type { LjubaLaunchOptions } from './types.js';

/**
 * LjubaBrowser takes an HTMLElement container (the OrbPreview DOM node)
 * and provides a Playwright-compatible Browser API for in-browser verification.
 */
export class LjubaBrowser {
  private container: HTMLElement;

  private constructor(container: HTMLElement) {
    this.container = container;
  }

  static async launch(container: HTMLElement): Promise<LjubaBrowser> {
    return new LjubaBrowser(container);
  }

  async newContext(options?: LjubaLaunchOptions): Promise<LjubaContext> {
    return new LjubaContext(this.container, options);
  }

  async close(): Promise<void> {
    // no-op: we don't own the browser
  }
}
