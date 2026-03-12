/**
 * Server walk: BFS over a running server's API.
 *
 * Uses @almadar/core walkStatePairs to traverse the state machine
 * and POST events to the server for each (state, event) pair.
 *
 * @packageDocumentation
 */

export {
  walkStatePairs,
  buildStateGraph,
  type StateEdge,
  type GraphTransition,
} from '@almadar/core';
