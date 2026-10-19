import { describe, it, expect } from 'vitest';
import type { EmitStep } from '@almadar/core/kernel-wire';
import { emitStep } from '../adapt.js';

const confirm: EmitStep = {
  trait: 'ContactDelete',
  from: 'idle',
  event: 'CONFIRM_DELETE',
  payload: { id: 'Contact-verify-seed-1' },
  navigates: false,
  coverageKey: 'ContactDelete:idle+CONFIRM_DELETE->idle[emit]',
};

describe('emitStep', () => {
  it('binds a real row where a listener persists by the emitted id, avoiding restrict-referenced rows', () => {
    const step = emitStep({
      ...confirm,
      bindRow: {
        entity: 'Contact',
        payloadField: 'id',
        wholeRow: false,
        avoidReferencedVia: [],
        avoidReferencedByOtherEntities: [{ entity: 'Deal', field: 'contactId' }],
      },
    });
    expect(step.bindRowFrom).toEqual({
      entityName: 'Contact',
      payloadField: 'id',
      wholeRow: false,
      avoidReferencedByOtherEntities: [{ entityName: 'Deal', fieldName: 'contactId' }],
    });
  });

  it('control: an emit no listener writes by id binds no row', () => {
    expect(emitStep(confirm).bindRowFrom).toBeUndefined();
  });
});
