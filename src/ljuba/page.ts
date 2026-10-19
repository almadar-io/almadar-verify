import { LjubaLocator } from './locator.js';
import type { LjubaScreenshotOptions } from './types.js';

/**
 * LjubaPage wraps an HTMLElement container (the OrbPreview DOM node)
 * with a Playwright-compatible Page API for in-browser verification.
 */
export class LjubaPage {
  private container: HTMLElement;
  private listeners: Array<{ event: string; handler: EventListener }> = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async goto(url: string): Promise<void> {
    // In Studio, navigation happens through the app's router.
    // Dispatch a custom event that OrbPreview listens to.
    this.container.dispatchEvent(
      new CustomEvent('ljuba:navigate', { detail: { url } })
    );
    await this.settle();
  }

  locator(selector: string): LjubaLocator {
    return new LjubaLocator(this.container, selector);
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    return fn();
  }

  async screenshot(options?: LjubaScreenshotOptions): Promise<Uint8Array> {
    void options;
    // html2canvas dynamic import (optional dependency)
    try {
      const mod = await import('html2canvas');
      const html2canvas = mod.default;
      const canvas = await html2canvas(this.container);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b: Blob | null) => resolve(b!), 'image/png')
      );
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      throw new Error(
        'html2canvas not available. Install it for screenshot support.'
      );
    }
  }

  async waitForSelector(
    selector: string,
    options?: { timeout?: number }
  ): Promise<void> {
    const timeout = options?.timeout ?? 5000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.container.querySelector(selector)) return;
      await new Promise<void>(r => setTimeout(r, 50));
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise<void>(r => setTimeout(r, ms));
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (event === 'console') {
      const wrappedHandler = (e: Event) => {
        const detail = (e as CustomEvent).detail as
          | { type?: string; text?: string }
          | undefined;
        handler({
          type: () => detail?.type ?? 'log',
          text: () => detail?.text ?? '',
        });
      };
      this.container.addEventListener('ljuba:console', wrappedHandler);
      this.listeners.push({ event: 'ljuba:console', handler: wrappedHandler });
    }
  }

  removeListener(event: string, _handler: (...args: unknown[]) => void): void {
    void event;
    // Simplified cleanup: removes all listeners for the mapped event
    const mapped = event === 'console' ? 'ljuba:console' : event;
    this.listeners = this.listeners.filter(l => {
      if (l.event === mapped) {
        this.container.removeEventListener(l.event, l.handler);
        return false;
      }
      return true;
    });
  }

  private async settle(): Promise<void> {
    await new Promise<void>(r => setTimeout(r, 300));
  }
}
