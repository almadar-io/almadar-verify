/**
 * Loading unpacked extensions into Chromium: the generic half of verifying a program compiled to a
 * browser extension. A tiny MV3 extension stands in; nothing here knows any shell's layout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extensionWorker, launchBrowserWithExtensions } from '../launch.js';
import { ConsoleCollector } from '../console.js';

function extension(workerSource: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-ext-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0', background: { service_worker: 'worker.js' } }));
  writeFileSync(join(dir, 'worker.js'), workerSource);
  return dir;
}

describe('launchBrowserWithExtensions', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0)) await c();
  });

  it('loads an unpacked extension and reaches its service worker', async () => {
    const dir = extension('self.answer = 42;');
    const { context } = await launchBrowserWithExtensions({ extensions: [dir] });
    cleanup.push(() => context.close(), () => rmSync(dir, { recursive: true, force: true }));
    const { worker, extensionId } = await extensionWorker(context);
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(await worker.evaluate(() => (self as typeof self & { answer: number }).answer)).toBe(42);
  });

  it('control: the extension pages are served from the worker\'s extension origin', async () => {
    const dir = extension('');
    writeFileSync(join(dir, 'page.html'), '<p id="p">from the extension</p>');
    const { context } = await launchBrowserWithExtensions({ extensions: [dir] });
    cleanup.push(() => context.close(), () => rmSync(dir, { recursive: true, force: true }));
    const { extensionId } = await extensionWorker(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/page.html`);
    expect(await page.textContent('#p')).toBe('from the extension');
  });

  it('passes extra Chromium switches through (a host mapped to a local server)', async () => {
    const dir = extension('');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p id="p">served locally</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const { context } = await launchBrowserWithExtensions({ extensions: [dir], args: [`--host-resolver-rules=MAP fixture.test 127.0.0.1:${port}`] });
    cleanup.push(() => context.close(), () => void server.close(), () => rmSync(dir, { recursive: true, force: true }));
    const page = await context.newPage();
    await page.goto('http://fixture.test/');
    expect(await page.textContent('#p')).toBe('served locally');
  });

  it('edge: launching with no extension is refused, not a plain browser', async () => {
    await expect(launchBrowserWithExtensions({ extensions: [] })).rejects.toThrow(/at least one/);
  });

  it('edge: an extension with no service worker is reported, not waited on forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-ext-'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'bare', version: '1.0.0' }));
    const { context } = await launchBrowserWithExtensions({ extensions: [dir] });
    cleanup.push(() => context.close(), () => rmSync(dir, { recursive: true, force: true }));
    await expect(extensionWorker(context, { timeout: 1500 })).rejects.toThrow(/no extension service worker/);
  });
});

describe('ConsoleCollector on an extension service worker', () => {
  it('collects the worker\'s console errors, warnings and info', async () => {
    const dir = extension("setTimeout(() => { console.error('worker broke'); console.warn('worker wary'); console.log('worker fine'); }, 300);");
    const { context } = await launchBrowserWithExtensions({ extensions: [dir] });
    try {
      const { worker } = await extensionWorker(context);
      const collector = new ConsoleCollector(worker);
      await new Promise((r) => setTimeout(r, 800));
      const { errors, warnings } = collector.getResults();
      expect(errors).toEqual(['worker broke']);
      expect(warnings).toEqual(['worker wary']);
      expect(collector.getEntries().map((e) => e.text)).toContain('worker fine');
      collector.dispose();
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
