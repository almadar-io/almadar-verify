/**
 * `isUiFactoryBoard` — recognizes a lolo-ui GENERATED factory board by the
 * generator's own source stamp: every emitted board carries
 * `"<Name> — UI factory (1:1 with the @almadar/ui <pattern> pattern)."` as its
 * description. Source-tagged classification — never inferred from behavior
 * names or file paths.
 *
 * Why it matters to verification: factory boards are pure content vessels.
 * By construction every config knob is optional-or-defaulted (required knobs
 * are seeded at generation time), and the boot render paints only what the
 * call site feeds through config. An empty boot render with all knobs at
 * defaults is therefore the CONTRACT, not a defect — the deliberate
 * alternative to seeding sample content into board defaults, which leaks
 * into every non-overriding consumer (the historical "wave purge" class in
 * lolo-ui's seeding policy). Consumers of this helper soften only the
 * boot-content expectations (blank-slot probe, INIT portal expectations);
 * every other check (unknown pattern, error boundary, click-truth, coverage)
 * stays fully strict on factory boards.
 *
 * @packageDocumentation
 */

const UI_FACTORY_STAMP = '— UI factory (1:1';

/** Accepts anything description-bearing (`OrbitalSchema`, a tool's parsed
 *  behavior schema) so the stamp has exactly one owner. */
export function isUiFactoryBoard(orbital: { description?: string }): boolean {
  return orbital.description?.includes(UI_FACTORY_STAMP) === true;
}
