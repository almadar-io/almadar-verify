/**
 * serviceManifest reads the services registry: which services an app calls, and whether each is
 * usable with the given credentials. A registry `oneOf` group (email: SendGrid OR Resend) is
 * satisfied by any one member and missing when none is present.
 */
import { describe, it, expect } from 'vitest';
import type { Effect, OrbitalSchema } from '@almadar/core';
import { serviceManifest } from '../service-manifest.js';

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

const sendMail: Effect = ['call-service', 'email', 'send', { to: 'a@example.com', subject: 's', body: 'b' }];

describe('serviceManifest credential groups', () => {
  it('a oneOf group with no member present is missing, naming every member', () => {
    const result = serviceManifest(callingApp(sendMail), {});
    expect(result.entries[0].configured).toBe(false);
    expect(result.findings.join('\n')).toMatch(/one of SENDGRID_API_KEY, RESEND_API_KEY/);
  });

  it('control: any one member satisfies the group', () => {
    for (const env of [{ RESEND_API_KEY: 're' }, { SENDGRID_API_KEY: 'sg' }]) {
      const result = serviceManifest(callingApp(sendMail), env);
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
