/**
 * `lintPluginWiring` — static, deterministic CROSS-REGISTRY lint of a
 * plugin's wiring against the host/capability atoms it targets.
 *
 * Sibling of `lintWiring` (`wiring-lint.ts`), not a case inside it:
 * `lintWiring` walks ONE resolved schema; this walks a plugin's resolved
 * schema against N separately-resolved TARGET schemas (the atoms the
 * plugin `uses` — a host-protocol atom like `studio-shell`, a capability
 * atom like `ui-code-block`/`std-modal-editor`). Both inputs must already
 * be RESOLVED (`orbital resolve`): a `uses`-composed trait is stored on the
 * raw registry `.orb` as an unresolved `{ ref, name }` stub with no
 * `emits`/`stateMachine` of its own — only after resolve does it carry a
 * full body plus `Trait.sourceBehavior` provenance
 * (`{ behavior, alias, originalName }`, set by the inline phase — see
 * `@almadar/core`'s `Trait.sourceBehavior` doc).
 *
 * Composed-trait emit attribution — RELAY vs REQUEST, decided structurally
 * (no name/provenance matching): a composed trait's external emit is a
 * **relay** when every state-machine arm that fires it is triggered by an
 * event NOT declared in that trait's own resolved `listens[].triggers` and
 * not `INIT` — the host injects the trigger directly
 * (`processOrbitalEvent(orbital, {event, targetTrait})`, bypassing this
 * trait's subscription surface entirely), so the trait is only relaying a
 * host→plugin signal outward; a plugin that never listens for it is not a
 * dead wire. Every other external emit is a **request**: at least one firing
 * arm's trigger IS a declared `listens[].triggers` entry (a bare local
 * payload declaration or a source-qualified route), meaning the plugin's OWN
 * logic decided to fire it — the plugin's genuine output, needing a target
 * listener. Relay emits are excluded from `plugin-emit-no-host-listener` and
 * `plugin-emit-payload-mismatch` (see `isRelayEmit`); request emits are
 * checked as before. Verified live: `vim-mode`'s `Shell = ShellAtom.traits.
 * StudioShellTrait -> VimShellState {}` inherits `studio-shell`'s empty
 * `listens` — every `SHELL_*`-triggered arm is host-injected, so all 9 of
 * `Shell`'s inherited emits are relays (`KEY`/`PLUGIN_ENABLED` also happen to
 * be same-plugin-consumed, independently of this). `vim-mode`'s `Modes =
 * Modal.traits.Modes -> VimEditorMode { listens { Shell.KEY -> KEY with
 * {...} } }` REBINDS a `listens` entry whose `triggers` is `KEY` — every arm
 * in `Modes` is a `KEY`-triggered arm, so `SET_MODE`/`MOTION`/`OPERATE`/
 * `INSERT_TEXT`/`EX_COMMAND` are all requests. The ONE structural exclusion
 * at the orbital level, matching the literal contract: a plugin's resolved
 * schema that (for some future composition shape) embeds a whole TARGET
 * orbital wholesale is not scanned as "the plugin's own" for that orbital —
 * see `pluginOwnOrbitals`. Trait-level composition (the only shape today) is
 * always scanned.
 *
 * "Bare listens entry" on a target: this codebase's compiled atoms
 * (`studio-shell`, `ui-code-block`) do not populate a `listens[]` array for
 * their externally-driven inbound events at all — `COMMAND`/`STATUS`/
 * `REGISTER_COMMAND` on `studio-shell` and `MOTION`/`OPERATE`/`INSERT_TEXT`/
 * `SET_MODE` on `ui-code-block` are plain, unqualified state-machine
 * TRANSITIONS (event name with no source), reachable by any direct
 * `processOrbitalEvent(orbital, {event, targetTrait})` call — which is
 * exactly what the plugin host does (`OrbitalPluginHost` inbound rows). A
 * transition's bare `event` name IS the target's declared bare-listen
 * surface in this IR; `TraitEventListener` entries with `source: undefined`
 * (the formal "local payload declaration" shape — see `ListenSource` doc in
 * `@almadar/core`) are the OTHER spelling of the same thing and are checked
 * too, so an atom authored either way is covered.
 *
 * Checks:
 *  - `plugin-emit-no-host-listener` — a REQUEST external emit (see above —
 *    relay emits are skipped) on any trait of the plugin's own orbital(s)
 *    whose event name matches NEITHER a bare consumption site on any
 *    target's traits NOR a same-plugin listener (another trait in this same
 *    plugin schema subscribing to it). A dead wire: the plugin fires the
 *    event and nothing in the declared target set, nor the plugin itself,
 *    will ever receive it.
 *  - `plugin-emit-payload-mismatch` — same REQUEST-only scope: the event
 *    name DOES match a target's bare consumption site, but a field that
 *    transition's own effects read via `@payload.<field>` is missing from
 *    every declared production site of the plugin's emit
 *    (`suppliedPayloadFields`, reused verbatim from `wiring-lint.ts`), or —
 *    where the field flows directly into `(set @entity.<F> ?<field>)` and
 *    the target's linked entity declares `<F>`'s type — the emit's own
 *    `payloadSchema` type for that field is a different primitive. A relay
 *    emit has no host consumer to mismatch against, so it is excluded here
 *    too. Mirrors `payload-starved-route`'s contract, one registry over.
 *  - `plugin-listen-source-not-host` — a source-qualified `listens`
 *    (`X.EVENT`, `ListenSource.kind !== 'any'`) on a plugin trait whose
 *    source trait is neither declared in the plugin's own orbital(s) NOR in
 *    any target's orbitals — a dangling cross-registry reference that can
 *    never fire, undetectable by `lintWiring` (single-schema: it only knows
 *    the plugin's own traits) and undetectable by `orb validate` (which
 *    resolves `uses` per-file, not against an arbitrary target roster).
 *
 * @packageDocumentation
 */

import type {
  Entity,
  EntityRef,
  Orbital,
  OrbitalSchema,
  Trait,
} from '@almadar/core';
import { getTraitName, isEntityCall, isEntityReference, isInlineTrait } from '@almadar/core';
import { suppliedPayloadFields } from './wiring-lint.js';
import type { WiringLintFinding, WiringLintResult } from './wiring-lint.js';

/** One host/capability atom the plugin may target, keyed by the name the
 *  caller resolved it under (its behavior name — `studio-shell`,
 *  `ui-code-block`, …), already RESOLVED (`orbital resolve`). */
export interface PluginWiringTarget {
  name: string;
  schema: OrbitalSchema;
}

/** One inline trait plus the orbital that declares it. */
interface OwnedTrait {
  orbitalName: string;
  trait: Trait;
}

/**
 * The plugin's own orbitals: every orbital in `plugin.orbitals` EXCEPT one
 * whose NAME matches an orbital name present in a target schema — the
 * literal "orbitals it composes by ref from targets" exclusion. Today's
 * only composition shape (`uses X from "…"` + `trait Y = X.traits.Z -> …`)
 * clones a TRAIT into the plugin's own single orbital, never a whole
 * target orbital, so this is a no-op on the corpus as authored; it stays
 * general for a composition shape that does embed one.
 */
function pluginOwnOrbitals(plugin: OrbitalSchema, targets: readonly PluginWiringTarget[]): Orbital[] {
  const targetOrbitalNames = new Set<string>();
  for (const target of targets) {
    for (const orb of target.schema.orbitals) targetOrbitalNames.add(orb.name);
  }
  return plugin.orbitals.filter((orb) => !targetOrbitalNames.has(orb.name));
}

/** Every inline trait declared across a schema's orbitals, keyed by name
 *  (last declaration wins — orbital/trait names are unique per schema in
 *  practice). REF stubs (unresolved `uses` imports) are skipped: a caller
 *  that hands in a raw, unresolved `.orb` gets no findings rather than
 *  false ones — the contract requires resolved inputs (see file header). */
function inlineTraitsOf(orbitals: readonly Orbital[]): Map<string, OwnedTrait> {
  const out = new Map<string, OwnedTrait>();
  for (const orb of orbitals) {
    for (const ref of orb.traits ?? []) {
      if (isInlineTrait(ref)) out.set(ref.name, { orbitalName: orb.name, trait: ref });
    }
  }
  return out;
}

/** True when some OTHER trait in the same plugin schema (any of its own
 *  orbitals) declares a `listens` route that would receive `event` fired by
 *  `sourceTraitName` — the "consumed by a same-app listener" exemption. A
 *  `source: undefined` entry is a local payload declaration, not a
 *  subscription (see `ListenSource` doc), and does not count. */
function consumedWithinPlugin(
  pluginTraits: ReadonlyMap<string, OwnedTrait>,
  sourceOrbitalName: string,
  sourceTraitName: string,
  event: string,
): boolean {
  for (const { trait } of pluginTraits.values()) {
    for (const listen of trait.listens ?? []) {
      if (listen.event !== event) continue;
      const source = listen.source;
      if (source === undefined) continue;
      if (source.kind === 'any') return true;
      if (source.kind === 'trait' && source.trait === sourceTraitName) return true;
      if (source.kind === 'orbital' && source.trait === sourceTraitName && source.orbital === sourceOrbitalName) {
        return true;
      }
    }
  }
  return false;
}

/** The local state-machine trigger names `trait`'s own `listens[]` produces
 *  (`TraitEventListener.triggers` — the same field for a bare local payload
 *  declaration and a source-qualified route; see `ListenSource` doc). An arm
 *  triggered by one of these fired because of a declared subscription, not
 *  because a caller dispatched the event directly. */
function declaredTriggers(trait: Trait): Set<string> {
  return new Set((trait.listens ?? []).map((l) => l.triggers));
}

/** Every state-machine transition's own trigger (`transition.event`) where a
 *  top-level effect fires `['emit', event, {…}]` — the same top-level shape
 *  `suppliedPayloadFields` scans (nested/conditional emits are not modeled
 *  there either). */
function firingTriggerEvents(trait: Trait, event: string): Set<string> {
  const out = new Set<string>();
  for (const transition of trait.stateMachine?.transitions ?? []) {
    for (const effect of transition.effects ?? []) {
      if (Array.isArray(effect) && effect[0] === 'emit' && effect[1] === event) {
        out.add(transition.event);
        break;
      }
    }
  }
  return out;
}

/** A RELAY emit (see file header): every arm that fires `event` was
 *  triggered by something other than this trait's own declared `listens`
 *  routes and isn't `INIT` — a host→plugin signal the trait re-emits
 *  outward, not a request the plugin's own logic is making. `false` when no
 *  arm fires the event at all (a different, already-covered defect — a
 *  declared-but-unfired emit — not this check's concern). */
function isRelayEmit(trait: Trait, event: string): boolean {
  const triggers = firingTriggerEvents(trait, event);
  if (triggers.size === 0) return false;
  const declared = declaredTriggers(trait);
  return [...triggers].every((t) => t !== 'INIT' && !declared.has(t));
}

/** A target trait matched as a bare consumer of `event` — see the file
 *  header for what "bare" means in this IR (a plain transition event name,
 *  or a `listens` entry with no source qualification). */
interface TargetMatch {
  targetName: string;
  orbital: Orbital;
  trait: Trait;
}

/** Every target trait that bare-consumes `event`, across every target and
 *  every orbital/trait it declares. */
function targetTraitsConsuming(targets: readonly PluginWiringTarget[], event: string): TargetMatch[] {
  const matches: TargetMatch[] = [];
  for (const target of targets) {
    for (const orb of target.schema.orbitals) {
      for (const ref of orb.traits ?? []) {
        if (!isInlineTrait(ref)) continue;
        const bareListen = (ref.listens ?? []).some((l) => l.event === event && l.source === undefined);
        const bareTransition = (ref.stateMachine?.transitions ?? []).some((t) => t.event === event);
        if (bareListen || bareTransition) matches.push({ targetName: target.name, orbital: orb, trait: ref });
      }
    }
  }
  return matches;
}

/** Inline `Entity` narrow of an `EntityRef` (excludes the string/`EntityCall`
 *  reference forms — this lint only resolves fields it can see inline on
 *  the already-resolved target schema). */
function inlineEntity(ref: EntityRef | undefined): Entity | undefined {
  if (ref === undefined || isEntityReference(ref) || isEntityCall(ref)) return undefined;
  return ref;
}

/** Declared field type for `entityName.fieldName` on `orb` — checked
 *  against both the orbital's primary `entity` and its `auxiliaryEntities`
 *  (a resolved `.orb` carries a composed trait's linked entity in either
 *  slot depending on import order). */
function entityFieldType(orb: Orbital, entityName: string | undefined, fieldName: string): string | undefined {
  if (entityName === undefined) return undefined;
  const candidates: Entity[] = [];
  const primary = inlineEntity(orb.entity);
  if (primary !== undefined) candidates.push(primary);
  for (const aux of orb.auxiliaryEntities ?? []) {
    const entity = inlineEntity(aux);
    if (entity !== undefined) candidates.push(entity);
  }
  const entity = candidates.find((e) => e.name === entityName);
  return entity?.fields.find((f) => f.name === fieldName)?.type;
}

/** One required payload field the target's OWN transition for `event`
 *  reads (`@payload.<field>` anywhere in its effects), plus — when that
 *  read flows directly into `(set @entity.<F> ?<field>)` — the entity
 *  field name it lands in, so the caller can look up a declared type. */
interface RequiredField {
  name: string;
  entityFieldName?: string;
}

/** Every `@payload.<field>` binding reachable anywhere under an effect tree
 *  — the same duck-typed recursive-array walk `wiring-lint.ts`'s own
 *  helpers use (`embeddedTraitRefs`, `renderedAffordanceEvents`, …) rather
 *  than `@almadar/core`'s `collectBindings`: `Effect`'s variadic tuple arms
 *  (`AsyncAllEffect` et al.) are not structurally assignable to `SExpr`
 *  under TS's tuple/index-signature check, and this file's contract only
 *  needs the `@payload.` leaves, not a typed `SExpr` walk. */
function payloadBindingsOf(node: unknown): string[] {
  const out: string[] = [];
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.startsWith('@payload.')) out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) scan(child);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value as Readonly<Record<string, unknown>>)) scan(child);
    }
  };
  scan(node);
  return out;
}

/** Every `@payload.<field>` the target trait's transitions for `event`
 *  actually read — the target's real required-field set, derived
 *  structurally rather than from a formal (frequently absent, per the file
 *  header) payload schema. */
function requiredPayloadFields(trait: Trait, event: string): RequiredField[] {
  const byName = new Map<string, RequiredField>();
  for (const transition of trait.stateMachine?.transitions ?? []) {
    if (transition.event !== event) continue;
    for (const effect of transition.effects ?? []) {
      if (
        Array.isArray(effect) &&
        effect[0] === 'set' &&
        typeof effect[1] === 'string' &&
        effect[1].startsWith('@entity.') &&
        typeof effect[2] === 'string' &&
        effect[2].startsWith('@payload.')
      ) {
        const field = effect[2].slice('@payload.'.length);
        byName.set(field, { name: field, entityFieldName: effect[1].slice('@entity.'.length) });
        continue;
      }
      for (const binding of payloadBindingsOf(effect)) {
        const field = binding.slice('@payload.'.length);
        if (!byName.has(field)) byName.set(field, { name: field });
      }
    }
  }
  return [...byName.values()];
}

/** Primitive type names this check can compare with confidence. A field
 *  typed anything else (an entity name, `[User]`, …) is left uncompared —
 *  no verdict rather than a false positive on a type vocabulary this check
 *  does not model. */
const COMPARABLE_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'object', 'array']);

/** `int` is the only alias this codebase's payload/entity type vocabularies
 *  disagree on for an otherwise-numeric field (docs: EventPayloadField.type
 *  is compiler-narrowed per call site, not here; entity fields use the
 *  closed `TraitFieldType` set, which has no `int`). */
function normalizeType(type: string): string {
  return type === 'int' ? 'number' : type;
}

/** `true` only when both types are in the comparable set and disagree —
 *  never for a type this check cannot model. */
function typesDisagree(emitType: string, targetType: string): boolean {
  const a = normalizeType(emitType);
  const b = normalizeType(targetType);
  if (!COMPARABLE_TYPES.has(a) || !COMPARABLE_TYPES.has(b)) return false;
  return a !== b;
}

export function lintPluginWiring(
  plugin: OrbitalSchema,
  targets: readonly PluginWiringTarget[],
): WiringLintResult {
  const findings: WiringLintFinding[] = [];
  const ownOrbitals = pluginOwnOrbitals(plugin, targets);
  const pluginTraits = inlineTraitsOf(ownOrbitals);

  // --- plugin-emit-no-host-listener + plugin-emit-payload-mismatch -------
  for (const [traitName, { orbitalName, trait }] of pluginTraits) {
    for (const emit of trait.emits ?? []) {
      if (emit.scope !== 'external') continue;
      if (isRelayEmit(trait, emit.event)) continue;
      if (consumedWithinPlugin(pluginTraits, orbitalName, traitName, emit.event)) continue;

      const matches = targetTraitsConsuming(targets, emit.event);
      if (matches.length === 0) {
        findings.push({
          check: 'plugin-emit-no-host-listener',
          severity: 'error',
          orbital: orbitalName,
          trait: traitName,
          message:
            `${traitName} emits '${emit.event}' (external) but no target atom declares a bare consumption ` +
            `site for it, and no trait within this plugin schema listens for it either — the emit has nowhere to land`,
          suggestion:
            `declare listens { ${emit.event} {…} } (or a matching bare transition) on the target atom this ` +
            `plugin composes for '${emit.event}', add it to the target roster this plugin is checked against, ` +
            `or drop the emit if it is not meant to reach the host`,
        });
        continue;
      }

      const supplied = suppliedPayloadFields(trait, emit.event);
      if (supplied === 'runtime-forwarded') continue;
      for (const match of matches) {
        const required = requiredPayloadFields(match.trait, emit.event);
        const missing = required.filter((f) => !supplied.has(f.name));
        const typeIssues = required
          .filter((f) => !missing.includes(f) && f.entityFieldName !== undefined)
          .map((f) => {
            const emitType = trait.emits
              ?.find((e) => e.event === emit.event)
              ?.payloadSchema?.find((p) => p.name === f.name)?.type;
            const targetType = entityFieldType(match.orbital, match.trait.linkedEntity, f.entityFieldName!);
            if (emitType === undefined || targetType === undefined) return undefined;
            return typesDisagree(emitType, targetType) ? { field: f.name, emitType, targetType } : undefined;
          })
          .filter((x): x is { field: string; emitType: string; targetType: string } => x !== undefined);

        if (missing.length === 0 && typeIssues.length === 0) continue;
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing {${missing.map((f) => f.name).join(', ')}}`);
        for (const issue of typeIssues) parts.push(`'${issue.field}' is ${issue.emitType} but ${match.targetName} expects ${issue.targetType}`);
        findings.push({
          check: 'plugin-emit-payload-mismatch',
          severity: 'error',
          orbital: orbitalName,
          trait: traitName,
          message:
            `${traitName}: '${emit.event}' toward ${match.targetName} — ${parts.join('; ')} — the emit ` +
            `is payload-starved or type-mismatched and can never satisfy ${match.targetName}'s consuming transition`,
          suggestion:
            missing.length > 0
              ? `add {${missing.map((f) => f.name).join(', ')}} to the ${emit.event} emit payload on ${traitName}`
              : `align the declared payloadSchema type(s) on ${traitName}'s ${emit.event} emit with ${match.targetName}'s entity field type(s)`,
        });
      }
    }
  }

  // --- plugin-listen-source-not-host --------------------------------------
  for (const [traitName, { orbitalName, trait }] of pluginTraits) {
    for (const listen of trait.listens ?? []) {
      const source = listen.source;
      if (source === undefined || source.kind === 'any') continue;

      const sourceTraitName = source.trait;
      const inPlugin =
        source.kind === 'trait'
          ? pluginTraits.has(sourceTraitName)
          : plugin.orbitals.some(
              (orb) => orb.name === source.orbital && (orb.traits ?? []).some((ref) => getTraitName(ref) === sourceTraitName),
            );
      if (inPlugin) continue;

      const inTarget = targets.some((target) =>
        target.schema.orbitals.some(
          (orb) =>
            (source.kind !== 'orbital' || orb.name === source.orbital) &&
            (orb.traits ?? []).some((ref) => getTraitName(ref) === sourceTraitName),
        ),
      );
      if (inTarget) continue;

      findings.push({
        check: 'plugin-listen-source-not-host',
        severity: 'error',
        orbital: orbitalName,
        trait: traitName,
        message:
          `${traitName} listens for ${sourceTraitName}.${listen.event} but ${sourceTraitName} is declared ` +
          `neither in this plugin schema nor in any target atom — the route can never fire`,
        suggestion:
          `point the listen at a trait this plugin composes or a target atom actually declares, or add the ` +
          `atom that declares ${sourceTraitName} to the target roster this plugin is checked against`,
      });
    }
  }

  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
  };
}
