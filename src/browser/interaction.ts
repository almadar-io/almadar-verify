/**
 * Interaction utilities shared between orbital-verify and runtime-verify tools.
 *
 * Contains:
 * - buildMinimalPayload(): construct test payloads from field names
 * - classifyTargetPattern(): determine pattern behavior from registry
 * - fillFormFields(): generic DOM scanning to fill form inputs
 * - generateFieldValue(): faker-based test value generation
 * - clickSubmitAction(): find and click save/submit buttons
 * - clickCloseAction(): find and click close/cancel buttons
 * - countEntityRows(): count visible entity rows on page
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { faker } from '@faker-js/faker';

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
 * Classify a pattern using the @almadar/patterns registry.
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

// Seed faker for deterministic test runs
faker.seed(42);

/**
 * Generate a realistic test value for a form field based on its HTML input
 * type and name/id attributes. Uses @faker-js/faker for realistic data.
 *
 * Returns a string (all HTML inputs accept string values).
 */
export function generateFieldValue(inputType: string, _fieldName: string): string {
  switch (inputType) {
    case 'number':
      return String(faker.number.float({ min: 1, max: 999, fractionDigits: 2 }));
    case 'email':
      return faker.internet.email();
    case 'password':
      return faker.internet.password({ length: 12 });
    case 'tel':
      return faker.phone.number();
    case 'url':
      return faker.internet.url();
    case 'date':
      return faker.date.recent().toISOString().split('T')[0];
    case 'datetime-local':
      return faker.date.recent().toISOString().slice(0, 16);
    case 'color':
      return faker.color.rgb();
    case 'text':
    default:
      return faker.lorem.words(2);
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
 * Uses faker for realistic values, but prefers entity field `values` when available.
 *
 * @param fields - Payload field declarations from the event schema
 * @param entityFields - Optional entity field definitions (with `values` arrays) for meaningful data
 */
export function buildMinimalPayload(
  fields: Array<string | { name: string; type?: string }>,
  entityFields?: EntityFieldDef[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

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
      payload[name] = faker.lorem.sentence();
      continue;
    }
    if (name === 'category' && !entityField) {
      const agentCategories = ['preference', 'correction', 'pattern-affinity', 'entity-template', 'error-resolution'];
      payload[name] = agentCategories[0];
      continue;
    }
    if (name === 'query') {
      payload[name] = faker.lorem.words(3);
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

    switch (type) {
      case 'number':
      case 'integer':
      case 'float':
        payload[name] = faker.number.float({ min: 1, max: 999, fractionDigits: 2 });
        break;
      case 'boolean':
        payload[name] = faker.datatype.boolean();
        break;
      case 'date':
        payload[name] = faker.date.recent().toISOString();
        break;
      default:
        payload[name] = faker.lorem.words(2);
        break;
    }
  }
  return payload;
}

// ── Browser Form Filling ────────────────────────────────────────────

/**
 * Fill all visible form inputs within a container using generic DOM scanning.
 * Uses Playwright locator chaining (container.locator(child)) instead of
 * CSS string concatenation, which breaks with comma-separated container selectors.
 *
 * Returns the number of fields successfully filled.
 */
export async function fillFormFields(
  page: Page,
  containerSelector: string
): Promise<number> {
  const container = page.locator(containerSelector).first();
  const containerVisible = await container.isVisible({ timeout: 500 }).catch(() => false);
  if (!containerVisible) return 0;

  let filled = 0;

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
      filled++;
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
      await input.fill(generateFieldValue(typeAttr, nameAttr));
      filled++;
    } catch {
      // Skip
    }
  }

  // Fill textareas
  const textareas = container.locator('textarea:visible');
  const taCount = await textareas.count();
  for (let i = 0; i < taCount; i++) {
    try {
      await textareas.nth(i).fill(faker.lorem.sentence());
      filled++;
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
        await select.selectOption({ index: 1 });
        filled++;
      }
    } catch {
      // Skip
    }
  }

  return filled;
}

// ── Submit/Save Button Clicking ─────────────────────────────────────

/**
 * Find and click the submit/save action button within a container.
 * Tries multiple selector strategies in order of specificity.
 * Returns true if a button was found and clicked.
 */
export async function clickSubmitAction(
  page: Page,
  containerSelector: string
): Promise<boolean> {
  // Strategy 1: data-testid="action-SAVE" or data-testid="action-SUBMIT"
  for (const testId of ['action-SAVE', 'action-SUBMIT']) {
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

  // Strategy 2: button[type="submit"]
  const submitBtn = page.locator(`${containerSelector} button[type="submit"]`).first();
  try {
    if (await submitBtn.isVisible({ timeout: 1000 })) {
      await submitBtn.click();
      return true;
    }
  } catch {
    // Not found
  }

  // Strategy 3: Button with text matching save/submit/add/create/log
  for (const label of ['Save', 'Submit', 'Log', 'Add', 'Create']) {
    const textBtn = page.locator(`${containerSelector} button`).filter({ hasText: new RegExp(`^${label}`, 'i') }).first();
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
