<!-- Gap ledger for this repo: the source of truth for its open gaps. Managed with scripts/gaps-ledger.mjs in the Almadar monorepo. -->
# @almadar-io/verify — open gaps

Every open gap this repo owns lives here. This file is the source of truth; the monorepo's `docs/Almadar_Gaps.md` only rolls it up.

- **One entry per gap:** `- **<code>** — <what is wrong and where>. <owning package> [mechanical|architectural] — <evidence, prevention rung>`. `[mechanical]` = small and well-scoped; `[architectural]` = needs design judgment.
- **Codes:** new gaps use this repo's prefix `G-VERIFY-`. Take the "Next code" below, then bump it in the same edit. Codes are never reused or renamed.
- **Close by deleting.** Remove the entry in the same commit as the fix. There is no "closed" section; git history is the record.
- **Cross-repo gaps don't go here.** If fixing it needs another repo, describe it in your report or PR body; the monorepo coordinator files it.

Next code: `G-VERIFY-050`

## Open gaps

### Verify / Rabit / Almadar-Tools tier

- **G-VERIFY-044** — `guard-precondition-unreachable` ignores trait `ticks {}` as field writers. `findFieldSettingCandidates` / `sameTraitSetterSatisfies` (`planner/internal/guard-precondition.ts`) scan transitions only, so a guard whose field only a tick sets reads as unreachable and fails the walk. Example: `ui-platformer-board` `JUMP` (`@entity.player.grounded`) and `GAME_END -> won|lost` (`@entity.result`), both set by the 33 ms physics tick. The correct verdict is "established only by a tick — not plannable by the walk" (informational), not an error; the downstream `won|lost + PLAY_AGAIN` coverage gap then needs a tick-driven scene (play_scene) rather than a static preamble. `@almadar-io/verify` `[mechanical]` — found 2026-09-24 (game overhaul)
- **G-VERIFY-040** — Verifier path divergence on standalone `ui-*` pattern factories: `orb verify --trait ButtonRender` (Rust) PASSES 5/5, while `runtime-verify --trait ButtonRender` FAILS `click-no-listener` ("ButtonRender DOM click emitted \"ACTION\" but no trait subscribed") — the factory's `action` is a call-site knob whose standalone default has no listener, which the Rust path treats as a content vessel and the JS path does not. Pre-existing (reproduced 2026-09-24 on the committed `ui-button.lolo`, identical with and without the new `@pattern` tag). Resolve together with G-VERIFY-039 (one declared vessel fact read by both paths). Prevention: rung 3 parity (both verifiers must agree). `[architectural]`
- **G-VERIFY-001** — `verify_runtime`'s MCP schema names its param `file`, not `path`; passing `path` is silently ignored, reporting "No items to verify" instead of erroring on the wrong key. `[mechanical — tighten the schema so an unrecognized key is a validation error]` — orig: `Almadar_Tools_Gaps.md`
- **G-VERIFY-003** — `play_transition` can't discriminate between two guarded arms sharing one `(from, event)` pair (first arm always wins); `@config` binds for guard evaluation only, not effect-level reads. `[medium-high, probe-fidelity engineering]` — orig: `Almadar_Tools_Gaps.md` → T-PLAY-TRANSITION-MULTI-ARM-AND-CONFIG-SCOPE
- **G-VERIFY-006** — `orb verify` fast tier's global `maxFrames: 6` cap under-explores multi-key sequences. `[medium]` — orig: `Almadar_Sync_Gaps.md` → S-16
- **G-VERIFY-007** — `audit_listens` reports `wired:false` on a whole family of inline alert renders' DISMISS/CLOSE events (dozens of sites, e.g. std-fitness-studio ×55) — needs its own recipe + check. `[medium]` — orig: `Almadar_Std_Gaps.md`
- **G-VERIFY-008** — [sacred] `orbital-agent-cli`'s L0 spec hand-writes a `PlanSnapshot` literal instead of using rabit's own serializer. `[medium, touches rabit's serializer contract]` — orig: `Almadar_Agent_CLI_Gaps.md` → SCAN-KEYSTONE-HANDBUILT-SNAPSHOT-1
- **G-VERIFY-009** — [sacred] Low-tier L3 authoring model shipped a non-parsing riya atom. — orig: `Almadar_Rabit_Gaps.md` → R-L3-AUTHOR-POLAR-1
- **G-VERIFY-010** — [sacred, owner-decision] Small-surface orbitals burn the whole `search_knobs` budget on near-duplicate queries before `fill_params`. — orig: `Almadar_Rabit_Gaps.md` → SCAN-KNOB-CHURN-1
- **G-VERIFY-011** — [sacred, owner directive] L1 lane is token-heavy where it should be lean; no per-stage token accounting or deterministic compaction. — orig: `Almadar_Rabit_Gaps.md` → SCAN-L1-TOKEN-WEIGHT-1
- **G-VERIFY-012** — [sacred] Identical invalid `set_roster` retried to no-progress-bail; a small non-thinking model can't follow the corrective. — orig: `Almadar_Rabit_Gaps.md` → SCAN-ROSTER-RETRY-1
- **G-VERIFY-013** — [sacred] Event-typed config knobs accept arbitrary strings; an invented literal fails validate and demotes (first true demotion specimen). — orig: `Almadar_Rabit_Gaps.md` → SCAN-EVENT-KNOB-1
- **G-VERIFY-014** — [sacred] Composed wiring lint runs on unresolved schema, false-positive "viewer-stranded" on ref-trait data surfaces. — orig: `Almadar_Rabit_Gaps.md` → SCAN-LINT-UNRESOLVED-REF-1
- **G-VERIFY-015** — [sacred] Bare-string knob feeding a closed-vocabulary pattern prop (class check open, one instance already fixed). — orig: `Almadar_Rabit_Gaps.md` → SCAN-ENUM-KNOB-1
- **G-VERIFY-016** — [sacred, owner's in-flight work] 4 `materializeOrbitalLolo` tests assert the injection path on organisms that now hand-declare `expects`. — orig: `Almadar_Rabit_Gaps.md` → R-MATERIALIZE-FIXTURE-DRIFT-1
- **G-VERIFY-018** — [sacred] A shared entity read by 2 traits' render-ui violates single-render-authority. — orig: `Almadar_Rabit_Gaps.md` → SCAN-SHARED-RENDER-AUTHORITY-1
- **G-VERIFY-019** — [sacred] `DocumentSignatureBrowse` emits `CHECK_ENVELOPE_STATUS` with no listener. — orig: `Almadar_Rabit_Gaps.md` → SCAN-DEAD-EMIT-1
- **G-VERIFY-020** — [sacred] A mechanical delete-repair costs a full free-compose. — orig: `Almadar_Rabit_Gaps.md` → R-DELETE-CLEANUP-DEMOTES-1
- **G-VERIFY-021** — [sacred] A delete leaves a dangling entity relation; the app stops validating. — orig: `Almadar_Rabit_Gaps.md` → R-DELETE-CLEANUP-RELATION-1
- **G-VERIFY-022** — [sacred, owner direction needed] Questionnaire commit semantics live outside the package that defines them. — orig: `Almadar_Rabit_Gaps.md` → R-CONFIRMED-COMMIT-OWNERSHIP-1
- **G-VERIFY-023** — [sacred, owner's call] A failed snapshot edit has no recovery path. — orig: `Almadar_Rabit_Gaps.md` → R-FAILED-SNAPSHOT-EDIT-DEADEND-1
- **G-VERIFY-026** — [sacred] Same-turn free-compose siblings can never be sequenced or told about each other's entities. — orig: `Almadar_Studio_Gaps.md` → S11
- **G-VERIFY-027** — [sacred] A cross-orbital trait rename desyncs its own `@trait.<name>` references; every affected HIT demotes. — orig: `Almadar_Studio_Gaps.md` → S29
- **G-VERIFY-028** — [sacred] S13+S27 combination strands references (a composed surface can drop an entity owner a survivor still points at). — orig: `Almadar_Studio_Gaps.md` → S30
- **G-VERIFY-029** — [sacred] `PlanRepair` writes orbitals that were never planned (no session, no `spec.json`). — orig: `Almadar_Studio_Gaps.md` → S31
- **G-VERIFY-032** — Five capabilities the Studio QA prompt asked for don't exist at any layer; not yet itemized. `[needs enumeration first]` — orig: `Almadar_Studio_Gaps.md` → S15
- **G-VERIFY-034** — `audit_listens` / wiring lint cannot see dynamically-named `UI:${configKnob}` emits (`searchEvent`, `actionEvent`, `dismissEvent`, `directionEvent` pattern props) — it should resolve the knob's config value and audit that event like any static emit. Blocks the G-STD-005 sweep from being mechanical. `[medium]` — orig: G-STD-002 residual
- **G-VERIFY-036** — The 2026-09-24 chat fixes (the server leg carries the pre-dispatch row, a local seed posts its cascade's server work, the client binds `@config` in render effects, dispatches wait for the bridge topology) are verified on the JS runtime and on the Rust engine (`orb verify --trait`), but not on the compiled TS path (`orb verify --compiled`). The compiled engine can't be scoped with `--trait`, so checking it needs a full walk of std-realtime-chat + project-friday, or trait scoping added to the compiled engine. `[medium]` — orig: owner deferral 2026-09-24
- **G-VERIFY-037** — No gate catches a state whose visible content was rendered by ANOTHER state. std-realtime-chat's `ChatMentionSmsNotify` returned `sending -> ready` with only a notify, so `ready` kept showing "Sending…" and the "Notify by SMS" button was gone for good (fixed in the .lolo 2026-09-24: both result arms re-render the button). Prevention rung: 3 — a walk can record, per slot, which state last rendered it, and flag a transition into state S that leaves a slot showing content rendered only in a state other than S. Decidable on the resolved IR, so it's a candidate to promote into `orb validate` per the §111 doctrine. `[architectural]` — orig: G-RUNTIME-010 fix 2026-09-24
