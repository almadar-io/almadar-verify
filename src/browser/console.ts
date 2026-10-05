/**
 * Console message collector for Playwright pages.
 *
 * Collects console errors and warnings from a Playwright page,
 * filtering out noise (favicon, DevTools, net::ERR_, etc.).
 *
 * @packageDocumentation
 */

import type { Page, ConsoleMessage, Worker } from 'playwright';
import type { ConsoleEntry } from '../util/types.js';
import { isNoiseError, isNoiseWarning } from '../util/filter.js';

/**
 * Collects and categorizes console messages from a Playwright page or worker (a worker has no
 * `pageerror`; its uncaught errors reach the console).
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
  private target: Page | Worker;
  private consoleHandler: (msg: ConsoleMessage) => void;
  private errorHandler: (err: Error) => void;

  constructor(target: Page | Worker) {
    this.target = target;

    this.consoleHandler = (msg: ConsoleMessage) => {
      const text = msg.text();
      const timestamp = Date.now();
      const url = msg.location().url;
      const source = url !== '' ? { source: url } : {};

      if (msg.type() === 'error') {
        if (isNoiseError(text)) return;
        this.entries.push({ type: 'error', text, timestamp, ...source });
      } else if (msg.type() === 'warning') {
        if (isNoiseWarning(text)) return;
        this.entries.push({ type: 'warning', text, timestamp, ...source });
      } else {
        this.entries.push({ type: 'info', text, timestamp, ...source });
      }
    };

    this.errorHandler = (err: Error) => {
      this.uncaughtErrors.push(`Uncaught: ${err.message}`);
      this.entries.push({ type: 'error', text: `Uncaught: ${err.message}`, timestamp: Date.now() });
    };

    if (isPage(target)) {
      target.on('console', this.consoleHandler);
      target.on('pageerror', this.errorHandler);
    } else {
      target.on('console', this.consoleHandler);
    }
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
    const target = this.target;
    if (isPage(target)) {
      target.removeListener('console', this.consoleHandler);
      target.removeListener('pageerror', this.errorHandler);
    } else {
      target.removeListener('console', this.consoleHandler);
    }
  }
}

const isPage = (target: Page | Worker): target is Page => 'mainFrame' in target;
