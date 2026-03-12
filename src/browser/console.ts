/**
 * Console message collector for Playwright pages.
 *
 * Collects console errors and warnings from a Playwright page,
 * filtering out noise (favicon, DevTools, net::ERR_, etc.).
 *
 * @packageDocumentation
 */

import type { Page, ConsoleMessage } from 'playwright';
import type { ConsoleEntry } from '../util/types.js';
import { isNoiseError, isNoiseWarning } from '../util/filter.js';

/**
 * Collects and categorizes console messages from a Playwright page.
 *
 * Usage:
 * ```ts
 * const collector = new ConsoleCollector(page);
 * // ... navigate and interact ...
 * const { errors, warnings } = collector.getResults();
 * collector.dispose();
 * ```
 */
export class ConsoleCollector {
  private entries: ConsoleEntry[] = [];
  private uncaughtErrors: string[] = [];
  private page: Page;
  private consoleHandler: (msg: ConsoleMessage) => void;
  private errorHandler: (err: Error) => void;

  constructor(page: Page) {
    this.page = page;

    this.consoleHandler = (msg: ConsoleMessage) => {
      const text = msg.text();
      const timestamp = Date.now();

      if (msg.type() === 'error') {
        if (isNoiseError(text)) return;
        this.entries.push({ type: 'error', text, timestamp });
      } else if (msg.type() === 'warning') {
        if (isNoiseWarning(text)) return;
        this.entries.push({ type: 'warning', text, timestamp });
      } else {
        this.entries.push({ type: 'info', text, timestamp });
      }
    };

    this.errorHandler = (err: Error) => {
      this.uncaughtErrors.push(`Uncaught: ${err.message}`);
      this.entries.push({ type: 'error', text: `Uncaught: ${err.message}`, timestamp: Date.now() });
    };

    page.on('console', this.consoleHandler);
    page.on('pageerror', this.errorHandler);
  }

  /** Get all collected entries */
  getEntries(): ConsoleEntry[] {
    return [...this.entries];
  }

  /** Get categorized results */
  getResults(): { errors: string[]; warnings: string[]; uncaughtErrors: string[] } {
    return {
      errors: this.entries.filter((e) => e.type === 'error').map((e) => e.text),
      warnings: this.entries.filter((e) => e.type === 'warning').map((e) => e.text),
      uncaughtErrors: [...this.uncaughtErrors],
    };
  }

  /** Clear collected entries (useful between navigation steps) */
  clear(): void {
    this.entries = [];
    this.uncaughtErrors = [];
  }

  /** Remove event listeners from the page */
  dispose(): void {
    this.page.removeListener('console', this.consoleHandler);
    this.page.removeListener('pageerror', this.errorHandler);
  }
}
