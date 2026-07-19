/**
 * `planTickTests` — pure planner that turns a trait's declared `ticks {}`
 * rules into wait-and-observe walk steps, so a tick-driven trait (e.g.
 * snake's `step every 150ms`) gets real coverage instead of never having
 * its tick path exercised by the event-dispatch walk.
 *
 * For each declared tick with a numeric interval the step:
 *   1. carries `waitMs = interval` — the kernel (`tick()` in
 *      `driver/tick.ts`) waits at least the interval so the runtime's
 *      own tick scheduler fires,
 *   2. reads state/entity after the wait — `acceptStates` is the full
 *      declared topology, because a tick's effects may legitimately
 *      drive the trait into any reachable state (or hold it).
 *
 * `'frame'`-interval ticks fire on the render loop, not a wall-clock
 * schedule — there is no interval to wait out in a headless walk, so
 * they are skipped. Core types `TraitTick.interval` as `string | number`
 * (trait.ts) while the schema narrows it to `'frame' | positive number`;
 * any non-numeric interval is treated as `'frame'` and skipped.
 *
 * Pure. No browser, no I/O.
 *
 * @packageDocumentation
 */

import type { ExtendedWalkStep, PlanTickInput } from './types.js';

export function planTickTests(input: PlanTickInput): ExtendedWalkStep[] {
  const { trait } = input;
  const result: ExtendedWalkStep[] = [];

  // A tick's effects may move the trait anywhere in its declared
  // topology (snake's tick sets `over`, a reminder tick may emit a
  // transition event) — credit any declared state after the wait.
  const declaredStates = new Set<string>([trait.initialState]);
  for (const t of trait.transitions) {
    for (const from of Array.isArray(t.from) ? t.from : [t.from]) {
      if (from !== '*') declaredStates.add(from);
    }
    if (t.to !== '*') declaredStates.add(t.to);
  }
  const acceptStates = [...declaredStates];

  for (const tick of trait.ticks ?? []) {
    // 'frame' ticks are render-loop-driven — no wall-clock interval to
    // wait out headlessly. Non-positive numbers are invalid per the core
    // schema (`z.number().positive()`); skip defensively.
    if (typeof tick.interval !== 'number' || !(tick.interval > 0)) continue;

    result.push({
      from: trait.initialState,
      event: tick.name,
      to: trait.initialState,
      guardCase: null,
      payload: {},
      isRepositioning: false,
      traitName: trait.traitName,
      triggerKind: 'tick',
      coverageKey: `${trait.traitName}:tick(${tick.name})`,
      waitMs: tick.interval,
      acceptStates,
    });
  }

  return result;
}
