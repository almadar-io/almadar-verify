/**
 * `frame/` — the temporal unit of a verification run.
 *
 * @packageDocumentation
 */

export type {
  Frame,
  FrameCause,
  TriggerKind,
  TestKind,
  ConsoleDelta,
  EventLogDelta,
  EntityChange,
  EntityRowChange,
  DomSnapshot,
} from './types.js';

export {
  keyOf,
  diffConsole,
  diffEventLog,
  diffEntities,
  makeWalkFrame,
  makeInitFrame,
  type MakeFrameInput,
  type MakeInitFrameInput,
} from './factory.js';
