/**
 * A trait whose steps a role policy gates is walked, from its first step, as the first roster persona that role
 * admits (G-ORBITAL-SHELL-TYPESCRIPT-026): the row-picking step before a policed delete then sees the rows the delete
 * is admitted to, instead of the app default persona's ownership-scoped view.
 */
import { describe, it, expect } from 'vitest';
import type { RawUserClaims } from '@almadar/core';
import { traitPersona } from '../trait-persona.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

const step = (event: string, extra: Partial<ExtendedWalkStep> = {}): ExtendedWalkStep => ({
  from: 'idle', event, to: 'idle', guardCase: null, payload: {}, isRepositioning: false, traitName: 'ContactDelete',
  triggerKind: 'dom', coverageKey: `ContactDelete:idle+${event}->idle`, ...extra,
});

const owner: RawUserClaims = { id: 'TeamMember Id 1', role: 'owner' };
const manager: RawUserClaims = { id: 'TeamMember Id 2', role: 'manager' };
const admin: RawUserClaims = { id: 'TeamMember Id 3', role: 'admin' };
const roster = [owner, manager, admin];
const role = (value: string) => ({ role: { field: 'role', value } });

describe('traitPersona', () => {
  it('is the first roster persona the plan\'s role requirement admits', () => {
    const plan = [step('DELETE'), step('CONFIRM_DELETE', { viewerRequirement: role('admin') })];
    expect(traitPersona(plan, roster)).toEqual(admin);
  });

  it('reads a creator preamble\'s requirement too', () => {
    const plan = [step('CREATE', { establishesRow: { event: 'DO_CREATE', payload: {}, viewerRequirement: role('manager') } })];
    expect(traitPersona(plan, roster)).toEqual(manager);
  });

  it('control: a plan no role gates keeps the app default (no persona)', () => {
    expect(traitPersona([step('DELETE'), step('OPEN')], roster)).toBeUndefined();
  });

  it('edge: an owner-only requirement is resolved per step, never here', () => {
    const plan = [step('EDIT', { viewerRequirement: { owner: { sourceEntity: 'Contact', sourceField: 'owner' } } })];
    expect(traitPersona(plan, roster)).toBeUndefined();
  });

  it('edge: steps that need different roles leave the default, each step switching for itself', () => {
    const plan = [step('APPROVE', { viewerRequirement: role('admin') }), step('ASSIGN', { viewerRequirement: role('manager') })];
    expect(traitPersona(plan, roster)).toBeUndefined();
  });

  it('edge: a role no roster persona holds leaves the default', () => {
    expect(traitPersona([step('PURGE', { viewerRequirement: role('auditor') })], roster)).toBeUndefined();
  });
});
