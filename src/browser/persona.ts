import type { Page } from 'playwright';
import { z } from 'zod';
import { RawUserClaimsSchema, type RawUserClaims } from '@almadar/core';

export type PersonaHostKind = 'compiled' | 'playground';
export type PersonaBrowserWindow = Window & {
  __almadarAuth?: { signInWithCustomToken(token: string): Promise<string>; currentUid?(): Promise<string | null> };
  __almadarPlayground?: { signInAsSelectedPersona(): Promise<string | null>; currentUid?(): Promise<string | null> };
};

async function waitForPersonaBridge(page: Page, hostKind: PersonaHostKind): Promise<void> {
  try {
    await page.waitForFunction(kind => {
      const target = window as PersonaBrowserWindow;
      return kind === 'compiled' ? target.__almadarAuth !== undefined : target.__almadarPlayground !== undefined;
    }, hostKind, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`The ${hostKind} auth bridge is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readBrowserCurrentUid(page: Page, hostKind: PersonaHostKind): Promise<string | null> {
  await waitForPersonaBridge(page, hostKind);
  const uid = await page.evaluate(async kind => {
    const target = window as PersonaBrowserWindow;
    const bridge = kind === 'compiled' ? target.__almadarAuth : target.__almadarPlayground;
    if (typeof bridge?.currentUid !== 'function') throw new Error(`The ${kind} auth bridge does not expose currentUid`);
    return bridge.currentUid();
  }, hostKind);
  return z.string().min(1).nullable().parse(uid);
}

const rosterSchema = z.object({ personas: z.array(RawUserClaimsSchema) });
const compiledSignInSchema = z.object({ customToken: z.string().min(1) });
const playgroundSignInSchema = z.object({
  persona: RawUserClaimsSchema.nullable(),
  signIn: z.object({ customToken: z.string().min(1), authEmulatorHost: z.string(), projectId: z.string() }).nullable(),
  signInUnavailable: z.string().optional(),
});

export async function listBrowserPersonas(serverUrl: string, hostKind: PersonaHostKind, options: { allowUnavailable?: boolean } = {}): Promise<RawUserClaims[]> {
  const response = await fetch(`${serverUrl}${hostKind === 'compiled' ? '/api/personas' : '/api/orbitals/personas'}`);
  if (!response.ok && options.allowUnavailable) return [];
  if (!response.ok) throw new Error(`Persona roster answered ${response.status}: ${await response.text()}`);
  const { personas } = rosterSchema.parse(await response.json());
  const ids = new Set<string>();
  for (const persona of personas) {
    if (!persona.id || ids.has(persona.id)) throw new Error('Persona roster needs unique declared IDs');
    ids.add(persona.id);
  }
  return personas;
}

export async function signInBrowserPersona(
  page: Page,
  input: { serverUrl: string; hostKind: PersonaHostKind; personaId: string | null },
): Promise<{ persona: RawUserClaims | null; uid: string | null }> {
  const { serverUrl, hostKind, personaId } = input;
  if (hostKind === 'compiled' && personaId === null) throw new Error('Compiled anonymous viewing requires a fresh browser context');
  const roster = personaId === null ? [] : await listBrowserPersonas(serverUrl, hostKind);
  const persona = personaId === null ? null : roster.find(row => row.id === personaId);
  if (persona === undefined) throw new Error(`Persona '${personaId}' is not in the declared roster`);
  const response = await fetch(`${serverUrl}${hostKind === 'compiled' ? '/api/personas/sign-in' : '/api/orbitals/persona'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(hostKind === 'compiled' ? { id: personaId } : persona ?? {}),
  });
  if (!response.ok) throw new Error(`Persona sign-in answered ${response.status}: ${await response.text()}`);
  let token: string | undefined;
  if (hostKind === 'compiled') {
    token = compiledSignInSchema.parse(await response.json()).customToken;
  } else {
    const result = playgroundSignInSchema.parse(await response.json());
    if (result.persona?.id !== personaId && !(result.persona === null && personaId === null)) throw new Error('Server selected a different persona');
    if (personaId !== null && result.signIn === null) throw new Error(result.signInUnavailable ?? 'Persona sign-in is unavailable');
  }
  await waitForPersonaBridge(page, hostKind);
  const uid = await page.evaluate(async ({ kind, customToken }) => {
    const target = window as PersonaBrowserWindow;
    if (kind === 'compiled') {
      if (!target.__almadarAuth || customToken === undefined) throw new Error('Compiled auth bridge is unavailable');
      return target.__almadarAuth.signInWithCustomToken(customToken);
    }
    if (!target.__almadarPlayground) throw new Error('Playground auth bridge is unavailable');
    return target.__almadarPlayground.signInAsSelectedPersona();
  }, { kind: hostKind, customToken: token });
  if (uid !== personaId) throw new Error(`Auth bridge signed in '${uid}' instead of '${personaId}'`);
  return { persona, uid };
}
