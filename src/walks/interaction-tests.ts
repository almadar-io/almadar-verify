/**
 * Interaction test collection using @almadar/core BFS algorithms.
 *
 * Wraps the pure state machine algorithms with test-specific structure
 * (pattern classification, guard payload forking, replay paths).
 *
 * This module re-exports the logic needed by both orbital-verify and
 * runtime-verify. The actual BFS and guard payload algorithms are in
 * @almadar/core/state-machine.
 *
 * @packageDocumentation
 */

export {
  buildStateGraph,
  collectReachableStates,
  buildGuardPayloads,
  extractPayloadFieldRef,
  type StateEdge,
  type BFSNode,
  type ReplayStep,
  type GuardPayload,
} from '@almadar/core';
