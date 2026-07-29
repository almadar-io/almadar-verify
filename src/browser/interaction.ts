/**
 * Interaction utilities shared between orbital-verify and runtime-verify tools.
 *
 * Contains:
 * - buildMinimalPayload(): construct test payloads from field names
 * - classifyTargetPattern(): determine pattern behavior from registry
 * - fillFormFields(): generic DOM scanning to fill form inputs
 * - generateFieldValue(): seeded test value generation
 * - clickSubmitAction(): find and click save/submit buttons
 * - clickCloseAction(): find and click close/cancel buttons
 * - countEntityRows(): count visible entity rows on page
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import type { EventPayload, EventPayloadValue } from '@almadar/core';
import {
  seedRandom,
  randomFloat,
  randomEmail,
  randomPassword,
  randomPhone,
  randomUrl,
  randomRecentDate,
  randomColor,
  randomWords,
  randomSentence,
  randomBoolean,
  randomUuid,
  randomArrayElement,
} from '@almadar/runtime/mockRandom';
import { createLogger } from '@almadar/logger';

// Permanent observability for the DOM-side form-fill path. Surfaces
// the modal/form-mount race that earlier surfaces couldn't tell apart:
// container not visible vs container visible but fields not rendered
// vs fields rendered but fill failed. Gated by ALMADAR_DEBUG with
// namespace `almadar:verify:dom` so production verifier runs aren't
// noisy unless the operator opts in.
const domLog = createLogger('almadar:verify:dom');

// ── Pattern Classification ──────────────────────────────────────────

interface PatternEntry {
  category?: string;
  propsSchema?: Record<string, unknown>;
}

interface PatternRegistry {
  patterns: Record<string, PatternEntry>;
}

export interface PatternClassification {
  isForm: boolean;
  isDisplay: boolean;
  isComponent: boolean;
  hasSubmit: boolean;
  category: string;
}

/**
 * Classify a pattern using the @almadar/core/patterns registry.
 * Checks project registry first, then core registry.
 */
export function classifyTargetPattern(
  patternType: string,
  coreRegistry: PatternRegistry,
  projectRegistry?: PatternRegistry
): PatternClassification {
  const entry =
    projectRegistry?.patterns[patternType] ??
    coreRegistry.patterns[patternType];

  if (!entry) {
    return { isForm: false, isDisplay: false, isComponent: false, hasSubmit: false, category: 'unknown' };
  }

  const category = entry.category ?? 'unknown';
  const props = entry.propsSchema ?? {};
  const hasSubmit = 'onSave' in props || 'onSubmit' in props || 'submitEvent' in props;

  return {
    isForm: category === 'form',
    isDisplay: category === 'display',
    isComponent: category === 'component',
    hasSubmit,
    category,
  };
}

// ── Faker-based Value Generation ────────────────────────────────────

// Seed PRNG for deterministic test runs
seedRandom(42);

/**
 * Generate a realistic test value for a form field based on its HTML input
 * type and name/id attributes. Uses a seeded PRNG for realistic data.
 *
 * Returns a string (all HTML inputs accept string values).
 */
/**
 * A valid value for a semantic-domain field, or `undefined` when the type is not
 * one. Three near-identical payload switches used to fall through to
 * `randomWords(2)` for these, which the emitted `z.string().email()` refinement
 * rejects on submit — turning a real feature into a verifier regression.
 */
function semanticPayloadValue(type: string | undefined): string | undefined {
  switch (type) {
    case 'email':
      return 'verify@example.com';
    case 'url':
    case 'image':
      return 'https://example.com/verify';
    case 'phone':
      return '+1-555-0100';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000001';
    default:
      return undefined;
  }
}

/** String forms a planner may hand a checkbox that mean "unchecked". */
const FALSEY_FORM_VALUES: ReadonlySet<string> = new Set(['', 'false', '0', 'no', 'off', 'null', 'undefined']);

export function generateFieldValue(inputType: string, _fieldName: string): string {
  switch (inputType) {
    case 'number':
      return String(randomFloat({ min: 1, max: 999, fractionDigits: 2 }));
    case 'email':
      return randomEmail();
    case 'password':
      return randomPassword(12);
    case 'tel':
      return randomPhone();
    case 'url':
      return randomUrl();
    case 'date':
      return randomRecentDate().toISOString().split('T')[0]!;
    case 'datetime-local':
      return randomRecentDate().toISOString().slice(0, 16);
    case 'color':
      return randomColor();
    case 'text':
    default:
      return randomWords(2);
  }
}

/**
 * Entity field definition with optional predefined values.
 * Used to generate meaningful payloads when entity fields declare allowed values.
 */
export interface EntityFieldDef {
  name: string;
  type?: string;
  values?: string[];
}

/**
 * Build a minimal test payload from declared field names and types.
 * Uses the seeded PRNG for realistic values, but prefers entity field `values` when available.
 *
 * @param fields - Payload field declarations from the event schema
 * @param entityFields - Optional entity field definitions (with `values` arrays) for meaningful data
 */
export function buildMinimalPayload(
  fields: Array<string | { name: string; type?: string }>,
  entityFields?: EntityFieldDef[],
): EventPayload {
  const payload: EventPayload = {};

  // Build a lookup of entity fields by name for quick access
  const entityFieldMap = new Map<string, EntityFieldDef>();
  if (entityFields) {
    for (const ef of entityFields) {
      entityFieldMap.set(ef.name, ef);
    }
  }

  for (const field of fields) {
    const name = typeof field === 'string' ? field : field.name;
    const type = typeof field === 'string' ? 'string' : (field.type ?? 'string');

    // Check if any entity field has predefined values that match this payload field.
    // For a field named "value", check if there's an entity field whose name appears
    // in another payload field (e.g., payload has "field"="status" and "value" needs
    // to come from the status field's values array).
    const entityField = entityFieldMap.get(name);
    if (entityField?.values && entityField.values.length > 0) {
      // Pick the first predefined value for deterministic test results
      payload[name] = entityField.values[0];
      continue;
    }

    // For generic "field"/"value" pattern: if payload has a "field" entry that names
    // an entity field, and current entry is "value", use that entity field's values
    if (name === 'value' && typeof payload.field === 'string') {
      const referencedField = entityFieldMap.get(payload.field as string);
      if (referencedField?.values && referencedField.values.length > 0) {
        payload[name] = referencedField.values[0];
        continue;
      }
    }

    // For "field" payload entries: if an entity field has values, use that field name
    if (name === 'field' && entityFields) {
      const fieldWithValues = entityFields.find(ef => ef.values && ef.values.length > 0);
      if (fieldWithValues) {
        payload[name] = fieldWithValues.name;
        continue;
      }
    }

    // Agent-specific field generation
    if (name === 'content' || name === 'prompt') {
      payload[name] = randomSentence();
      continue;
    }
    if (name === 'category' && !entityField) {
      const agentCategories = ['preference', 'correction', 'pattern-affinity', 'entity-template', 'error-resolution'];
      payload[name] = agentCategories[0];
      continue;
    }
    if (name === 'query') {
      payload[name] = randomWords(3);
      continue;
    }
    if (name === 'toolName') {
      payload[name] = 'validate-schema';
      continue;
    }
    if (name === 'language') {
      payload[name] = 'typescript';
      continue;
    }
    if (name === 'strategy') {
      payload[name] = 'hybrid';
      continue;
    }

    // G45 / Phase B.10 part (1): array-typed payload fields. Events that
    // carry a list (e.g. `LOAD { data: [Conversation] }`) previously fell
    // through to the default branch and got `data: "lorem ipsum"` — a
    // string the receiving data-list / data-grid can't iterate, so the
    // pattern rendered empty even though VG checks all passed.
    // Detect the bracketed-entity shape `[Foo]` (or plain `array`) and
    // synthesize a one-element array using the entity's field types.
    const arrayMatch = typeof type === 'string'
      ? /^\[(.+)\]$/.exec(type) ?? (type === 'array' ? [type, ''] as const : null)
      : null;
    if (arrayMatch) {
      const inner = arrayMatch[1] ?? '';
      // For a structured-entity array, build one mock row from the
      // entity field defs (same path used by `object`/`any` below).
      // For a scalar array (`[string]`/`[number]`), produce 2-3 random
      // primitives so list patterns have visible rows.
      const isScalarInner =
        inner === 'string' || inner === 'number' || inner === 'integer' ||
        inner === 'float' || inner === 'boolean';
      if (isScalarInner) {
        const arr: EventPayloadValue[] = [];
        for (let i = 0; i < 3; i++) {
          if (inner === 'string') arr.push(randomWords(2));
          else if (inner === 'boolean') arr.push(randomBoolean());
          else arr.push(randomFloat({ min: 1, max: 999, fractionDigits: 2 }));
        }
        payload[name] = arr;
      } else if (entityFields && entityFields.length > 0) {
        const row: EventPayload = {};
        for (const ef of entityFields) {
          if (ef.values && ef.values.length > 0) {
            row[ef.name] = ef.values[0];
            continue;
          }
          const semantic = semanticPayloadValue(ef.type);
          if (semantic !== undefined) {
            row[ef.name] = semantic;
            continue;
          }
          switch (ef.type) {
            case 'number':
            case 'integer':
            case 'float':
              row[ef.name] = randomFloat({ min: 1, max: 999, fractionDigits: 2 });
              break;
            case 'boolean':
              row[ef.name] = randomBoolean();
              break;
            case 'date':
              row[ef.name] = randomRecentDate().toISOString();
              break;
            default:
              row[ef.name] = randomWords(2);
              break;
          }
        }
        payload[name] = [row];
      } else {
        payload[name] = [{ label: randomWords(2) }];
      }
      continue;
    }

    switch (type) {
      case 'string':
        // Explicit string-type fields produce a primitive random word.
        // Without this branch, strings fell through to the default's
        // entity-row expansion below, which produced an object instead
        // of a string — fillFormFieldsFromMap then `skipped-no-string-form`
        // because `fieldValueToString({...})` returns null on objects.
        // Confirmed via `[almadar:verify:dom] dom:fill:field-result
        // { name: 'description', result: 'skipped-no-string-form' }` on
        // the std-list crud-create step before this branch existed.
        payload[name] = randomWords(2);
        break;
      case 'number':
      case 'integer':
      case 'float':
        payload[name] = randomFloat({ min: 1, max: 999, fractionDigits: 2 });
        break;
      case 'boolean':
        payload[name] = randomBoolean();
        break;
      case 'date':
        payload[name] = randomRecentDate().toISOString();
        break;
      case 'object':
      case 'any':
        // When an event declares `data: object!` (e.g. SAVE carries the
        // form's submitted row), the payload field IS the entity shape.
        // Defaulting to a string here (via randomWords) persists
        // `data: "lorem ipsum"` — server stores it literally, DataGrid
        // tries to read row.name/row.description off a string and renders
        // a blank card. Build a real object from the entity field types
        // so the persisted row has the fields the grid renders.
        if (entityFields && entityFields.length > 0) {
          const obj: EventPayload = {};
          for (const ef of entityFields) {
            if (ef.values && ef.values.length > 0) {
              obj[ef.name] = ef.values[0];
              continue;
            }
            const semanticObj = semanticPayloadValue(ef.type);
            if (semanticObj !== undefined) {
              obj[ef.name] = semanticObj;
              continue;
            }
            switch (ef.type) {
              case 'number':
              case 'integer':
              case 'float':
                obj[ef.name] = randomFloat({ min: 1, max: 999, fractionDigits: 2 });
                break;
              case 'boolean':
                obj[ef.name] = randomBoolean();
                break;
              case 'date':
                obj[ef.name] = randomRecentDate().toISOString();
                break;
              default:
                obj[ef.name] = randomWords(2);
                break;
            }
          }
          payload[name] = obj;
        } else {
          payload[name] = { label: randomWords(2) };
        }
        break;
      default:
        // Entity-typed payload field. When `type` isn't a recognised
        // primitive / array / object marker but `entityFields` carries
        // a populated schema, treat the type as an entity-name reference
        // and expand it the same way as `'object' | 'any'` — i.e. build
        // a row from the entity's field definitions, including a
        // synthesized `id` that the persist op's id-resolution chain
        // (`data?.id ?? entity?.id ?? payload.entityId ?? payload.id`)
        // will pick up. Without this, std-list's
        // `listens { DO_UPDATE { data : ListItem } }` produced
        // `payload.data = 'lorem ipsum'` (a string) and the persistor's
        // update branch silently no-op'd because `data.id` was undefined.
        if (entityFields && entityFields.length > 0) {
          const row: EventPayload = { id: randomUuid() };
          for (const ef of entityFields) {
            if (ef.values && ef.values.length > 0) {
              row[ef.name] = ef.values[0];
              continue;
            }
            const semanticRow = semanticPayloadValue(ef.type);
            if (semanticRow !== undefined) {
              row[ef.name] = semanticRow;
              continue;
            }
            switch (ef.type) {
              case 'number':
              case 'integer':
              case 'float':
                row[ef.name] = randomFloat({ min: 1, max: 999, fractionDigits: 2 });
                break;
              case 'boolean':
                row[ef.name] = randomBoolean();
                break;
              case 'date':
                row[ef.name] = randomRecentDate().toISOString();
                break;
              default:
                row[ef.name] = randomWords(2);
                break;
            }
          }
          payload[name] = row;
        } else {
          payload[name] = randomWords(2);
        }
        break;
    }
  }
  return payload;
}

// ── Browser Form Filling ────────────────────────────────────────────

/**
 * Values a {@link fillFormFieldsWithValues} call set on the form,
 * keyed by the input's `name` attribute (or a stable positional key
 * when name is missing). Feeds post-submit assertions — a verifier can
 * search the resulting DOM for each filled value and confirm the row
 * it submitted actually appeared. Closes the "form filled, server
 * acknowledged, but is the row on screen?" gap that counting alone
 * misses.
 */
export type FilledFormValues = Record<string, string>;

export interface FilledFormResult {
  count: number;
  values: FilledFormValues;
}

/**
 * Fill every visible input/textarea/select within `containerSelector`
 * and return a map of `name → value` for the fields that were actually
 * filled. Callers asserting "the row I just created shows up" iterate
 * this map and check each value's text is present in the target list.
 */
export async function fillFormFieldsWithValues(
  page: Page,
  containerSelector: string
): Promise<FilledFormResult> {
  const container = page.locator(containerSelector).first();
  const containerVisible = await container.isVisible({ timeout: 500 }).catch(() => false);
  if (!containerVisible) return { count: 0, values: {} };

  const values: FilledFormValues = {};
  let count = 0;
  const keyFor = (name: string, fallback: string): string => (name && name.length > 0 ? name : fallback);

  // Fill text-like, number, and password inputs
  const inputs = container.locator(
    'input[type="text"]:visible, input[type="number"]:visible, ' +
    'input[type="email"]:visible, input[type="tel"]:visible, ' +
    'input[type="url"]:visible, input[type="password"]:visible, ' +
    'input:not([type]):visible'
  );
  const inputCount = await inputs.count();
  for (let i = 0; i < inputCount; i++) {
    try {
      const input = inputs.nth(i);
      const typeAttr = await input.getAttribute('type') ?? 'text';
      const nameAttr = await input.getAttribute('name') ?? '';
      const value = generateFieldValue(typeAttr, nameAttr);
      await input.fill(value);
      values[keyFor(nameAttr, `input-${i}`)] = value;
      count++;
    } catch {
      // Input may have become detached
    }
  }

  // Fill date/datetime inputs
  const dateInputs = container.locator('input[type="date"]:visible, input[type="datetime-local"]:visible');
  const dateCount = await dateInputs.count();
  for (let i = 0; i < dateCount; i++) {
    try {
      const input = dateInputs.nth(i);
      const typeAttr = await input.getAttribute('type') ?? 'date';
      const nameAttr = await input.getAttribute('name') ?? '';
      const value = generateFieldValue(typeAttr, nameAttr);
      await input.fill(value);
      values[keyFor(nameAttr, `date-${i}`)] = value;
      count++;
    } catch {
      // Skip
    }
  }

  // Check boolean inputs. Excluded from the text selector above because
  // `fill()` throws on them — but skipping them entirely drops the key from
  // the submitted payload, which reads as a broken behavior rather than an
  // unset control.
  const toggles = container.locator('input[type="checkbox"]:visible, input[type="radio"]:visible');
  const toggleCount = await toggles.count();
  for (let i = 0; i < toggleCount; i++) {
    try {
      const toggle = toggles.nth(i);
      const nameAttr = await toggle.getAttribute('name') ?? '';
      await toggle.setChecked(true);
      values[keyFor(nameAttr, `toggle-${i}`)] = 'true';
      count++;
    } catch {
      // Toggle may have become detached
    }
  }

  // Fill textareas
  const textareas = container.locator('textarea:visible');
  const taCount = await textareas.count();
  for (let i = 0; i < taCount; i++) {
    try {
      const ta = textareas.nth(i);
      const nameAttr = await ta.getAttribute('name') ?? '';
      const value = randomSentence();
      await ta.fill(value);
      values[keyFor(nameAttr, `textarea-${i}`)] = value;
      count++;
    } catch {
      // Skip
    }
  }

  // Select first non-placeholder option for select elements
  const selects = container.locator('select:visible');
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i++) {
    try {
      const select = selects.nth(i);
      const options = await select.locator('option').allTextContents();
      if (options.length > 1) {
        const nameAttr = await select.getAttribute('name') ?? '';
        await select.selectOption({ index: 1 });
        values[keyFor(nameAttr, `select-${i}`)] = options[1] ?? '';
        count++;
      }
    } catch {
      // Skip
    }
  }

  return { count, values };
}

/**
 * Back-compat wrapper for callers that only want the count. Delegates
 * to {@link fillFormFieldsWithValues}; values are discarded. New callers
 * that want to verify submitted data later should use the -WithValues
 * form directly.
 */
export async function fillFormFields(
  page: Page,
  containerSelector: string,
): Promise<number> {
  const result = await fillFormFieldsWithValues(page, containerSelector);
  return result.count;
}

// ── Targeted form fill (Frame pipeline) ─────────────────────────────

import type { FieldValue } from '@almadar/core';

/**
 * Fill specific form fields with caller-supplied values, keyed by the
 * input's `name` attribute. Used by the Frame pipeline's Driver when a
 * planner extension produces a step with `step.formData` set —
 * deterministic test inputs (e.g. an interaction test that wants to
 * SAVE a CartItem with name="Apple", description="red fruit") instead
 * of PRNG-generated noise.
 *
 * Fields not present in `formData` are ignored. Fields in `formData`
 * with no matching input are silently skipped (the planner may know
 * about logical payload fields the rendered form doesn't expose).
 *
 * Returns the count of inputs actually filled.
 */
export async function fillFormFieldsFromMap(
  page: Page,
  containerSelector: string,
  formData: Record<string, FieldValue>,
): Promise<number> {
  const expectedKeys = Object.keys(formData);
  domLog.debug('dom:fill:enter', {
    containerSelector,
    expectedKeyCount: expectedKeys.length,
    expectedKeys: expectedKeys.join(','),
  });

  const container = page.locator(containerSelector).first();
  const containerVisible = await container.isVisible({ timeout: 500 }).catch(() => false);
  domLog.debug('dom:fill:container-visible', {
    containerSelector,
    visible: containerVisible,
  });
  if (!containerVisible) {
    domLog.debug('dom:fill:exit', {
      containerSelector,
      attempted: 0,
      filled: 0,
      containerVisible: false,
      reason: 'container-not-visible',
    });
    return 0;
  }

  let count = 0;
  let attempted = 0;

  for (const [name, value] of Object.entries(formData)) {
    if (value === null || value === undefined) {
      domLog.debug('dom:fill:field-result', { name, result: 'skipped-null-value' });
      continue;
    }
    const stringValue = fieldValueToString(value);
    if (stringValue === null) {
      domLog.debug('dom:fill:field-result', { name, result: 'skipped-no-string-form' });
      continue;
    }

    attempted++;

    // ONE deterministic selector: `data-field-name="<name>"`. Every
    // form-rendering path in `@almadar/ui` (Form.tsx commonProps,
    // InputPattern/TextareaPattern/SelectPattern) stamps this attribute
    // at source. If a render is missing it, that's a UI bug to fix in
    // `@almadar/ui` — never add fallback strategies here.
    const fieldSelector = `[data-field-name="${name}"]`;
    const field = container.locator(fieldSelector).first();
    const visible = await field.isVisible({ timeout: 200 }).catch(() => false);
    const tag = visible
      ? await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => null)
      : null;
    // `fill()` THROWS on controls it cannot type into ("Input of type
    // 'checkbox' cannot be filled", "Cannot type text into input[type=number]"),
    // which aborts the rest of the form and makes the submit fire with a
    // half-built payload — a red that says nothing about the behavior.
    const inputType = tag === 'input'
      ? (await field.getAttribute('type').catch(() => null)) ?? 'text'
      : null;
    domLog.debug('dom:fill:field-attempt', {
      name,
      selector: fieldSelector,
      visible,
      tag,
      inputType,
    });
    if (!visible) {
      domLog.debug('dom:fill:field-result', {
        name,
        result: 'skipped-not-visible',
        value: stringValue,
      });
      continue;
    }
    try {
      if (tag === 'select') {
        // The synthesized value may not be one of the `<select>`'s options:
        // the form field is typed `string`, which loses the entity's enum
        // values, so a status/category select gets a random string.
        // Try the exact value, then fall back to the first real option — an
        // empty REQUIRED select blocks the native form submit, so the submit
        // event (e.g. SAVE) never fires and the create/edit silently no-ops.
        try {
          await field.selectOption(stringValue);
        } catch {
          const optionValues = await field
            .locator('option')
            .evaluateAll((opts) => opts
              .map((o) => (o as HTMLOptionElement).value)
              .filter((v) => v !== ''));
          if (optionValues.length === 0) throw new Error('select has no selectable options');
          await field.selectOption(optionValues[0]);
        }
      } else if (inputType === 'checkbox' || inputType === 'radio') {
        // A boolean field is SET, not typed. Leaving it untouched (the old
        // behaviour of the generic scanner) silently drops the key from the
        // submitted payload.
        await field.setChecked(!FALSEY_FORM_VALUES.has(stringValue.toLowerCase()));
      } else if (inputType === 'number' || inputType === 'range') {
        // The planner types form fields as `string`, so a numeric input can
        // receive a word. Re-synthesize in range rather than fail the form.
        const numeric = Number(stringValue);
        await field.fill(
          Number.isFinite(numeric) && stringValue.trim() !== ''
            ? stringValue
            : generateFieldValue('number', name),
        );
      } else {
        await field.fill(stringValue);
      }
      count++;
      domLog.debug('dom:fill:field-result', {
        name,
        result: 'filled',
        value: stringValue,
        tag,
        inputType,
      });
    } catch (err) {
      // Field exists with the right tag but value couldn't be set
      // (e.g. select option not in the list). Surface as 0 contribution
      // to count — the planner needs to align with the entity's enum.
      domLog.debug('dom:fill:field-result', {
        name,
        result: 'errored',
        value: stringValue,
        tag,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  domLog.debug('dom:fill:exit', {
    containerSelector,
    attempted,
    filled: count,
    containerVisible: true,
  });
  return count;
}

/**
 * Project a `FieldValue` into the string form Playwright's
 * `input.fill()` and `select.selectOption()` accept. Booleans become
 * `'true'`/`'false'`. Dates become ISO strings. Arrays/objects are not
 * fillable as form inputs and return `null` (caller skips the field).
 */
function fieldValueToString(value: FieldValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  // Arrays + nested objects: not directly fillable into a form input.
  return null;
}

// ── Submit/Save Button Clicking ─────────────────────────────────────

/**
 * Click the form's submit button. ONE deterministic selector:
 * `[data-testid="action-<submitEvent>"]`. Every form-rendering path in
 * `@almadar/ui` (Form.tsx, ComponentPatterns.tsx) stamps this on the
 * submit Button. If the rendered DOM doesn't carry it, the form's
 * source needs to add the attribute — never add fallback strategies.
 *
 * `submitEvent` is the event key the form's submit dispatches (e.g.
 * "SAVE", "SUBMIT_REPORT", whatever the form-section's `submitEvent`
 * config says). The planner extracts this from the render-ui at plan
 * time and passes it through.
 */
export async function clickSubmitAction(
  page: Page,
  containerSelector: string,
  submitEvent: string,
): Promise<boolean> {
  const container = page.locator(containerSelector).first();
  const btn = container.locator(`[data-testid="action-${submitEvent}"]`).first();
  try {
    if (await btn.isVisible({ timeout: 1000 })) {
      await btn.click();
      return true;
    }
  } catch {
    // The button isn't visible / clickable — that's a UI contract gap.
    // Don't fall back: the form's submit Button must carry
    // `data-testid="action-<submitEvent>"`.
  }
  return false;
}

// ── Entity Row Counting ─────────────────────────────────────────────

/**
 * Count entity rows currently visible on the page.
 * Uses multiple selector strategies to find entity rows across different
 * pattern types (data-grid, data-list, entity-cards, entity-table, etc.).
 *
 * Returns the count of visible entity rows, or -1 if no entity container
 * is found (page doesn't have a list/grid pattern).
 */
export async function countEntityRows(page: Page): Promise<number> {
  // Strategy 1: explicit entity-row markers
  const entityRows = page.locator('[data-entity-row]');
  const directCount = await entityRows.count();
  if (directCount > 0) return directCount;

  // Strategy 2: data-grid table rows (tbody tr)
  const gridRows = page.locator('[data-pattern="data-grid"] tbody tr');
  const gridCount = await gridRows.count();
  if (gridCount > 0) return gridCount;

  // Strategy 3: data-list items (each item is a direct child of the list container)
  const listItems = page.locator('[data-pattern="data-list"] [data-entity-id]');
  const listCount = await listItems.count();
  if (listCount > 0) return listCount;

  // Strategy 4: entity-cards pattern
  const cardItems = page.locator('[data-pattern="entity-cards"] [data-entity-id]');
  const cardCount = await cardItems.count();
  if (cardCount > 0) return cardCount;

  // Strategy 5: entity-table rows
  const tableRows = page.locator('[data-pattern="entity-table"] tbody tr');
  const tableCount = await tableRows.count();
  if (tableCount > 0) return tableCount;

  // Strategy 6: any visible table rows in main slot (fallback)
  const mainTableRows = page.locator('#slot-main tbody tr');
  const mainCount = await mainTableRows.count();
  if (mainCount > 0) return mainCount;

  return -1;
}

// ── Close/Cancel Button Clicking ────────────────────────────────────

/**
 * Find and click a close/cancel action button within a container.
 * Returns true if a button was found and clicked.
 */
export async function clickCloseAction(
  page: Page,
  containerSelector: string
): Promise<boolean> {
  // Strategy 1: data-testid
  for (const testId of ['action-CLOSE', 'action-CANCEL']) {
    const btn = page.locator(`${containerSelector} [data-testid="${testId}"]`).first();
    try {
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        return true;
      }
    } catch {
      // Not found
    }
  }

  // Strategy 2: Button text
  for (const label of ['Close', 'Cancel', 'Back', 'Dismiss']) {
    const textBtn = page.locator(`${containerSelector} button`).filter({ hasText: new RegExp(`^${label}$`, 'i') }).first();
    try {
      if (await textBtn.isVisible({ timeout: 500 })) {
        await textBtn.click();
        return true;
      }
    } catch {
      // Not found
    }
  }

  return false;
}
