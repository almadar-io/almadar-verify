import type { SExpr } from '@almadar/core';
import { describe, expect, it } from 'vitest';
import * as verify from '../../index.js';
import { applyRowAccess, checkMutationAccess } from '@almadar/runtime';

describe('public canonical policy access', () => {
  it('exports the runtime implementation without wrapping it', () => {
    expect(verify.applyRowAccess).toBe(applyRowAccess);
    expect(verify.checkMutationAccess).toBe(checkMutationAccess);
  });
  it('permits owner-bound members while retaining declared role and non-owner denials', () => {
    const row = { customer: 'member-a', quantity: 1 };
    const member = { id: 'member-a', role: 'member' };
    const owner: SExpr = ['=', ['object/get', '@entity', 'customer'], '@user.id'];
    expect(verify.checkMutationAccess(row, undefined, { user: member })).toBe(true);
    expect(verify.applyRowAccess([row], owner, undefined, { user: member })).toEqual([row]);
    expect(verify.applyRowAccess([row], owner, undefined, { user: { id: 'member-b', role: 'member' } })).toEqual([]);
    expect(verify.checkMutationAccess(row, ['=', '@user.role', 'customer'], { user: member })).toBe(false);
    expect(verify.checkMutationAccess(row, ['=', '@user.role', 'customer'], { user: { id: 'customer-a', role: 'customer' } })).toBe(true);
  });
});
