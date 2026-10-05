/**
 * Loading unpacked extensions into Chromium: the generic half of verifying a program compiled to a
 * browser extension. A tiny MV3 extension stands in; nothing here knows any shell's layout.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extensionWorker, launchBrowserWithExtensions } from '../launch.js';
import { ConsoleCollector } from '../console.js';

const INSTALLED_CHROME = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/google/chrome/chrome';

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

  it.skipIf(!existsSync(INSTALLED_CHROME))('runs the installed Google Chrome with the extension loaded, and finds its worker among Chrome\'s own', async () => {
    const dir = extension('self.answer = 7;');
    const { context, extensionIds } = await launchBrowserWithExtensions({ extensions: [dir], channel: 'chrome' });
    cleanup.push(() => context.close(), () => rmSync(dir, { recursive: true, force: true }));
    expect(extensionIds).toHaveLength(1);
    const { worker, extensionId } = await extensionWorker(context, { extensionId: extensionIds[0] });
    expect(extensionId).toBe(extensionIds[0]);
    expect(await worker.evaluate(() => (self as typeof self & { answer: number }).answer)).toBe(7);
  }, 60_000);

  it('control: in Chromium the loaded extension ids are learned from the worker, not known up front', async () => {
    const dir = extension('');
    const { context, extensionIds } = await launchBrowserWithExtensions({ extensions: [dir] });
    cleanup.push(() => context.close(), () => rmSync(dir, { recursive: true, force: true }));
    expect(extensionIds).toEqual([]);
    expect((await extensionWorker(context)).extensionId).toMatch(/^[a-p]{32}$/);
  });

  it('edge: the on-device model needs the installed Chrome', async () => {
    await expect(launchBrowserWithExtensions({ extensions: ['/nonexistent'], onDeviceModel: true })).rejects.toThrow(/channel 'chrome'/);
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

describe('ConsoleCollector entry sources', () => {
  it('records which script logged each entry: the page\'s own, or the extension\'s content script', async () => {
    const dir = extension('');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'probe', version: '1.0.0', background: { service_worker: 'worker.js' }, content_scripts: [{ matches: ['http://fixture.test/*'], js: ['content.js'] }] }));
    writeFileSync(join(dir, 'content.js'), "console.error('content script broke');");
    const server = createServer((req, res) => {
      if (req.url === '/site.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end("console.error('site broke');");
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<script src="/site.js"></script><p>page</p>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const { context } = await launchBrowserWithExtensions({ extensions: [dir], args: [`--host-resolver-rules=MAP fixture.test 127.0.0.1:${port}`] });
    try {
      const { extensionId } = await extensionWorker(context);
      const page = await context.newPage();
      const collector = new ConsoleCollector(page);
      await page.goto('http://fixture.test/');
      await new Promise((r) => setTimeout(r, 800));
      const sources = Object.fromEntries(collector.getEntries().map((e) => [e.text, e.source]));
      expect(sources['site broke']).toBe('http://fixture.test/site.js');
      expect(sources['content script broke']).toBe(`chrome-extension://${extensionId}/content.js`);
      collector.dispose();
    } finally {
      await context.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
