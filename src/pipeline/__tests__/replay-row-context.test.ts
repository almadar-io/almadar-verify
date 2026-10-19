/**
 * A replay hop through a row-opening transition (`idle --DELETE--> confirming`, whose guard reads `@payload.row`)
 * carries the row the walk's crud step for that same transition binds (G-ORBITAL-SHELL-TYPESCRIPT-026): replayed with
 * only an id, the guard refuses it and the preamble diverges before the step it leads to.
 */
import { describe, it, expect } from 'vitest';
import { replayRowContext } from '../replay-row-context.js';
import type { ExtendedWalkStep } from '../../planner/types.js';

const step = (from: string, event: string, to: string, extra: Partial<ExtendedWalkStep> = {}): ExtendedWalkStep => ({
  from, event, to, guardCase: null, payload: {}, isRepositioning: false, traitName: 'ContactDelete', triggerKind: 'dom',
  coverageKey: `ContactDelete:${from}+${event}->${to}`, ...extra,
});

const shape = [{ name: 'id', wholeRow: false }, { name: 'row', wholeRow: true }];
const crudDelete = step('idle', 'DELETE', 'confirming', { testKind: 'crud-delete', expectedRowDelta: { entityName: 'Contact', delta: -1 }, payloadRowShape: shape });

describe('replayRowContext', () => {
  it('binds the hop to the crud step\'s entity and row shape', () => {
    expect(replayRowContext(step('idle', 'DELETE', 'confirming'), [crudDelete])).toEqual({
      bindRowFrom: { entityName: 'Contact', payloadField: 'id', wholeRow: false },
      payloadRowShape: shape,
    });
  });

  it('control: a hop no crud step shares a transition with is left as it is', () => {
    expect(replayRowContext(step('confirming', 'CANCEL', 'idle'), [crudDelete])).toEqual({});
  });

  it('edge: a hop that already binds a row keeps its own binding', () => {
    const own = step('idle', 'DELETE', 'confirming', { bindRowFrom: { entityName: 'Contact', payloadField: 'pick', wholeRow: true } });
    expect(replayRowContext(own, [crudDelete])).toEqual({});
  });

  it('edge: a crud step with no row shape gives nothing to bind', () => {
    const bare = step('idle', 'DELETE', 'confirming', { testKind: 'crud-delete', expectedRowDelta: { entityName: 'Contact', delta: -1 } });
    expect(replayRowContext(step('idle', 'DELETE', 'confirming'), [bare])).toEqual({});
  });
});
