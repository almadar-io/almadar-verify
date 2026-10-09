import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser } from '../launch.js';
import { listBrowserPersonas, signInBrowserPersona, readBrowserCurrentUid, type PersonaBrowserWindow } from '../persona.js';

describe('persona browser transport contract', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const launched = await launchBrowser(); browser = launched.browser;
    page = await launched.context.newPage();
  });
  afterAll(async () => { await browser.close(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the exact declared roster row and verifies the real bridge result', async () => {
    const row = { id: 'owner', role: 'member', custom: 0 };
    const requests: Array<{ url: string; body?: BodyInit | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body });
      return Response.json(url.endsWith('/personas') ? { personas: [row] } : { persona: row, signIn: { customToken: 'server-token', authEmulatorHost: '127.0.0.1:9099', projectId: 'demo-test' } });
    }));
    await page.evaluate(() => { (window as PersonaBrowserWindow).__almadarPlayground = { async signInAsSelectedPersona() { return 'owner'; } }; });
    expect(await signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'playground', personaId: 'owner' })).toEqual({ persona: row, uid: 'owner' });
    expect(requests[1]).toEqual({ url: 'http://host/api/orbitals/persona', body: JSON.stringify(row) });
    await page.evaluate(() => { (window as PersonaBrowserWindow).__almadarPlayground = { async signInAsSelectedPersona() { return 'other'; } }; });
    await expect(signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'playground', personaId: 'owner' })).rejects.toThrow('instead of');
  });

  it('denies unknown IDs, duplicate IDs and unavailable requested sign-in', async () => {
    const fetcher = vi.fn(async () => Response.json({ personas: [{ id: 'owner' }] }));
    vi.stubGlobal('fetch', fetcher);
    await expect(signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'compiled', personaId: 'absent' })).rejects.toThrow('declared roster');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => Response.json({ personas: [{ id: 'owner' }, { id: 'owner' }] }));
    await expect(listBrowserPersonas('http://host', 'compiled')).rejects.toThrow('unique');
    fetcher.mockImplementation(async () => Response.json({ persona: { id: 'owner' }, signIn: null, signInUnavailable: 'emulator missing' }));
    fetcher.mockResolvedValueOnce(Response.json({ personas: [{ id: 'owner' }] }));
    await expect(signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'playground', personaId: 'owner' })).rejects.toThrow('emulator missing');
  });

  it('keeps compiled ID-only sign-in separate from playground selection and anonymous reset', async () => {
    const calls: Array<RequestInit | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init);
      return Response.json(init ? { customToken: 'issued-token' } : { personas: [{ id: 'member', role: 'member' }] });
    }));
    await page.evaluate(() => { (window as PersonaBrowserWindow).__almadarAuth = { async signInWithCustomToken(token) { if (token !== 'issued-token') throw new Error('wrong token'); return 'member'; } }; });
    expect((await signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'compiled', personaId: 'member' })).uid).toBe('member');
    expect(calls[1]?.body).toBe(JSON.stringify({ id: 'member' }));
    await expect(signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'compiled', personaId: null })).rejects.toThrow('fresh browser context');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ persona: null, signIn: null })));
    await page.evaluate(() => { (window as PersonaBrowserWindow).__almadarPlayground = { async signInAsSelectedPersona() { return null; } }; });
    expect(await signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'playground', personaId: null })).toEqual({ persona: null, uid: null });
  });

  it('limits optional unavailable handling to non-success HTTP responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not offered', { status: 404 })));
    expect(await listBrowserPersonas('http://host', 'compiled', { allowUnavailable: true })).toEqual([]);
    await expect(listBrowserPersonas('http://host', 'compiled')).rejects.toThrow('404');
    await expect(signInBrowserPersona(page, { serverUrl: 'http://host', hostKind: 'compiled', personaId: 'owner' })).rejects.toThrow('404');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ personas: [{ role: 'member' }] })));
    await expect(listBrowserPersonas('http://host', 'compiled', { allowUnavailable: true })).rejects.toThrow('unique declared IDs');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'bad successful response' })));
    await expect(listBrowserPersonas('http://host', 'compiled', { allowUnavailable: true })).rejects.toThrow();
  });

  it('reads settled bridge UID rather than substituting the last sign-in result', async () => {
    await page.evaluate(() => {
      (window as PersonaBrowserWindow).__almadarAuth = {
        async signInWithCustomToken() { return 'last-selection'; },
        async currentUid() { await new Promise(resolve => { setTimeout(resolve, 20); }); return 'restored-viewer'; },
      };
    });
    expect(await readBrowserCurrentUid(page, 'compiled')).toBe('restored-viewer');
    await page.evaluate(() => {
      (window as PersonaBrowserWindow).__almadarPlayground = { async signInAsSelectedPersona() { return 'last-selection'; }, async currentUid() { return null; } };
    });
    expect(await readBrowserCurrentUid(page, 'playground')).toBeNull();
  });

  it('rejects absent or malformed getters instead of inferring anonymous or selected UID', async () => {
    await page.evaluate(() => { (window as PersonaBrowserWindow).__almadarAuth = { async signInWithCustomToken() { return 'owner'; } }; });
    await expect(readBrowserCurrentUid(page, 'compiled')).rejects.toThrow('currentUid');
    await page.evaluate(() => { (window as PersonaBrowserWindow).__almadarAuth = { async signInWithCustomToken() { return 'owner'; }, async currentUid() { throw new Error('SDK restoration failed'); } }; });
    await expect(readBrowserCurrentUid(page, 'compiled')).rejects.toThrow('SDK restoration failed');
  });
});
