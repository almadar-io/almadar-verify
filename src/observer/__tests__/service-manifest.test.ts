/**
 * serviceManifest reads the services registry: which services an app calls, and whether each is
 * usable with the given credentials. A registry `oneOf` group (any one provider key) is
 * satisfied by any one member and missing when none is present.
 */
import { describe, it, expect } from 'vitest';
import type { Effect, OrbitalSchema } from '@almadar/core';
import { serviceManifest, type RegistryService } from '../service-manifest.js';

function callingApp(effect: Effect): OrbitalSchema {
  return {
    name: 'App',
    orbitals: [{
      name: 'Mailer',
      entity: { name: 'Mail', fields: [{ name: 'id', type: 'string' }] },
      pages: [],
      traits: [{
        name: 'Send',
        scope: 'instance',
        stateMachine: { states: [{ name: 'idle', isInitial: true }], events: [{ key: 'GO', name: 'Go' }], transitions: [{ from: 'idle', to: 'idle', event: 'GO', effects: [effect] }] },
      }],
    }],
  };
}

const generate: Effect = ['call-service', 'provider', 'generate', { userPrompt: 'hello' }];

const providerRegistry: Record<string, RegistryService> = {
  provider: {
    backend: 'production',
    actions: [{ name: 'generate' }],
    credentials: ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'OPENAI_API_KEY', 'OPEN_ROUTER_API_KEY'].map((envVar) => ({
      envVar, required: false, oneOf: 'provider', description: `${envVar} (any one provider key suffices)`,
    })),
  },
};

describe('serviceManifest credential groups', () => {
  it('a oneOf group with no member present is missing, naming every member', () => {
    const result = serviceManifest(callingApp(generate), {}, providerRegistry);
    expect(result.entries[0].configured).toBe(false);
    expect(result.findings.join('\n')).toMatch(/one of ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, KIMI_API_KEY, OPENAI_API_KEY, OPEN_ROUTER_API_KEY/);
  });

  it('control: any one member satisfies the group', () => {
    for (const env of [{ ANTHROPIC_API_KEY: 'an' }, { OPENAI_API_KEY: 'oa' }]) {
      const result = serviceManifest(callingApp(generate), env, providerRegistry);
      expect(result.entries[0].configured).toBe(true);
      expect(result.findings).toEqual([]);
    }
  });

  it('an unknown service is a finding', () => {
    expect(serviceManifest(callingApp(['call-service', 'nope-service', 'go', {}]), {}).findings.join('\n')).toMatch(/nope-service/);
  });

  it('control: an app that calls no service has no entries and no findings', () => {
    expect(serviceManifest(callingApp(['set', '@entity.id', 'x']), {})).toEqual({ entries: [], findings: [] });
  });
});
