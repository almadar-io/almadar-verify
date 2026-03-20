/**
 * Data presence assertions for entity verification.
 *
 * Verifies that entity data actually appears in the rendered DOM:
 * - EDIT forms should have pre-populated field values
 * - Browse pages should show entity data in list/card/table patterns
 * - VIEW modals should display entity field values
 *
 * These assertions close the gap where verification reports PASS
 * but the UI shows empty forms or blank detail panels.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';

/** Result of an edit form pre-population check */
export interface EditPrePopulationResult {
  /** Whether the edit form has any pre-populated fields */
  hasPrePopulatedFields: boolean;
  /** Total number of input fields found */
  totalFields: number;
  /** Number of fields that have non-empty values */
  populatedFields: number;
  /** Names of fields that are empty (should have been pre-populated) */
  emptyFieldNames: string[];
  /** Names of fields that have values */
  populatedFieldNames: string[];
}

/**
 * Check that an EDIT form has pre-populated field values.
 *
 * Must be called BEFORE fillFormFields() overwrites the values.
 * Scans all visible input, select, and textarea elements within
 * the container and checks if they have non-empty values.
 *
 * @param page - Playwright page
 * @param containerSelector - CSS selector for the form container
 */
export async function assertEditPrePopulated(
  page: Page,
  containerSelector: string
): Promise<EditPrePopulationResult> {
  return page.evaluate((selector) => {
    const container = document.querySelector(selector);
    if (!container) {
      return {
        hasPrePopulatedFields: false,
        totalFields: 0,
        populatedFields: 0,
        emptyFieldNames: [],
        populatedFieldNames: [],
      };
    }

    const inputs = container.querySelectorAll(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), select, textarea'
    );

    let totalFields = 0;
    let populatedFields = 0;
    const emptyFieldNames: string[] = [];
    const populatedFieldNames: string[] = [];

    for (const el of inputs) {
      const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      // Skip invisible elements
      if (input.offsetParent === null) continue;

      totalFields++;
      const name = input.getAttribute('name') ?? input.getAttribute('id') ?? `field-${totalFields}`;
      const value = input.value?.trim() ?? '';

      if (value.length > 0) {
        populatedFields++;
        populatedFieldNames.push(name);
      } else {
        emptyFieldNames.push(name);
      }
    }

    return {
      hasPrePopulatedFields: populatedFields > 0,
      totalFields,
      populatedFields,
      emptyFieldNames,
      populatedFieldNames,
    };
  }, containerSelector);
}

/** Result of entity data visibility check */
export interface EntityDataVisibleResult {
  /** Whether any expected values were found in the DOM */
  hasVisibleData: boolean;
  /** Number of expected values that were found */
  matchedCount: number;
  /** Total number of expected values checked */
  totalExpected: number;
  /** Values that were found in the DOM */
  matchedValues: string[];
  /** Values that were NOT found in the DOM */
  missingValues: string[];
}

/**
 * Check that expected entity data values appear in the rendered DOM.
 *
 * Compares known mock data values against the text content of an area
 * of the page. This catches "empty render" bugs where the UI structure
 * is correct but contains no actual data.
 *
 * @param page - Playwright page
 * @param expectedValues - Array of known values that should appear
 *                         (e.g., mock entity field values from Phase 3)
 * @param containerSelector - CSS selector for the area to check
 *                            (defaults to body for full page check)
 */
export async function assertEntityDataVisible(
  page: Page,
  expectedValues: string[],
  containerSelector = 'body'
): Promise<EntityDataVisibleResult> {
  // Filter out empty, very short, or purely numeric values that could
  // match accidentally (e.g., "1", "a", single digits)
  const checkableValues = expectedValues.filter(
    (v) => typeof v === 'string' && v.trim().length >= 3
  );

  if (checkableValues.length === 0) {
    return {
      hasVisibleData: true, // No meaningful values to check
      matchedCount: 0,
      totalExpected: 0,
      matchedValues: [],
      missingValues: [],
    };
  }

  const domText = await page.evaluate((selector) => {
    const container = document.querySelector(selector);
    return container?.textContent ?? '';
  }, containerSelector);

  const matchedValues: string[] = [];
  const missingValues: string[] = [];

  for (const value of checkableValues) {
    if (domText.includes(value)) {
      matchedValues.push(value);
    } else {
      missingValues.push(value);
    }
  }

  return {
    hasVisibleData: matchedValues.length > 0,
    matchedCount: matchedValues.length,
    totalExpected: checkableValues.length,
    matchedValues,
    missingValues,
  };
}

// ── VIEW Modal Data Assertions ──────────────────────────────────────

/** Result of a VIEW modal/detail panel data check */
export interface ViewDataResult {
  /** Whether the VIEW panel shows entity field values (not just labels) */
  hasFieldValues: boolean;
  /** Total data-field elements found */
  totalFields: number;
  /** Number of fields with non-empty value content */
  fieldsWithValues: number;
  /** Field names that have no visible value */
  emptyFieldNames: string[];
}

/**
 * Check that a VIEW modal/detail panel displays entity field values,
 * not just field labels with empty content next to them.
 *
 * Looks for elements with [data-field] attributes and checks that
 * each has meaningful text content. Falls back to checking the
 * container's overall text length if no data-field elements exist.
 *
 * @param page - Playwright page
 * @param containerSelector - CSS selector for the VIEW container
 * @param expectedFieldNames - Optional list of field names expected from schema
 */
export async function assertViewDataVisible(
  page: Page,
  containerSelector: string,
  expectedFieldNames?: string[]
): Promise<ViewDataResult> {
  return page.evaluate(({ selector, fieldNames }) => {
    const container = document.querySelector(selector);
    if (!container) {
      return { hasFieldValues: false, totalFields: 0, fieldsWithValues: 0, emptyFieldNames: [] };
    }

    // Strategy 1: Check [data-field] elements for value content
    const dataFields = container.querySelectorAll('[data-field]');
    if (dataFields.length > 0) {
      let fieldsWithValues = 0;
      const emptyFieldNames: string[] = [];

      for (const el of dataFields) {
        const fieldName = el.getAttribute('data-field') ?? 'unknown';
        const text = (el.textContent ?? '').trim();
        // A field "has value" if its text goes beyond just the label
        // (i.e., not just "FirstName" but "FirstName: John Doe" or a sibling with the value)
        if (text.length > fieldName.length + 2) {
          fieldsWithValues++;
        } else {
          emptyFieldNames.push(fieldName);
        }
      }

      return {
        hasFieldValues: fieldsWithValues > 0,
        totalFields: dataFields.length,
        fieldsWithValues,
        emptyFieldNames,
      };
    }

    // Strategy 2: No data-field attrs — check container text has meaningful content
    const containerText = (container.textContent ?? '').trim();
    // If field names are provided, check if any of them appear with values after them
    if (fieldNames && fieldNames.length > 0) {
      let fieldsWithValues = 0;
      const emptyFieldNames: string[] = [];

      for (const name of fieldNames) {
        // Check if the text contains the field name followed by some value content
        const idx = containerText.indexOf(name);
        if (idx >= 0) {
          // Get text after the field name
          const afterField = containerText.substring(idx + name.length).trim();
          // If there's substantial text after the field name, it has a value
          if (afterField.length > 2 && !afterField.startsWith(fieldNames.find(f => f !== name) ?? '')) {
            fieldsWithValues++;
          } else {
            emptyFieldNames.push(name);
          }
        } else {
          emptyFieldNames.push(name);
        }
      }

      return {
        hasFieldValues: fieldsWithValues > 0,
        totalFields: fieldNames.length,
        fieldsWithValues,
        emptyFieldNames,
      };
    }

    // Fallback: just check if container has enough text content
    return {
      hasFieldValues: containerText.length > 20,
      totalFields: 0,
      fieldsWithValues: containerText.length > 20 ? 1 : 0,
      emptyFieldNames: [],
    };
  }, { selector: containerSelector, fieldNames: expectedFieldNames });
}

// ── Form Field Type Assertions ──────────────────────────────────────

/** Expected field type from the schema */
export interface ExpectedFieldType {
  name: string;
  schemaType: string;
}

/** Result of a single field type check */
export interface FieldTypeMismatch {
  fieldName: string;
  schemaType: string;
  expectedHtmlType: string;
  actualHtmlType: string;
}

/** Result of form field type verification */
export interface FormFieldTypeResult {
  /** Whether all field types match expectations */
  allCorrect: boolean;
  /** Total fields checked */
  totalChecked: number;
  /** Number of correct matches */
  correctCount: number;
  /** Fields with mismatched types */
  mismatches: FieldTypeMismatch[];
}

/** Map schema field types to expected HTML input types */
const SCHEMA_TO_HTML_TYPE: Record<string, string[]> = {
  string: ['text', 'search', 'hidden', ''],
  number: ['number'],
  integer: ['number'],
  float: ['number'],
  date: ['date', 'datetime-local'],
  datetime: ['datetime-local', 'date'],
  boolean: ['checkbox'],
  email: ['email'],
  url: ['url'],
  tel: ['tel'],
  color: ['color'],
  password: ['password'],
};

/**
 * Check that form input types match their schema-declared entity field types.
 *
 * For example, a field declared as `type: "date"` should render as
 * `<input type="date">`, not `<input type="text">`.
 *
 * @param page - Playwright page
 * @param containerSelector - CSS selector for the form container
 * @param expectedFields - Entity field definitions from the schema
 */
export async function assertFormFieldTypes(
  page: Page,
  containerSelector: string,
  expectedFields: ExpectedFieldType[]
): Promise<FormFieldTypeResult> {
  // Get actual input types from the DOM
  const actualTypes = await page.evaluate(({ selector, fields }) => {
    const container = document.querySelector(selector);
    if (!container) return [] as Array<{ name: string; type: string; tag: string }>;

    return fields.map(f => {
      // Try input[name], then select[name], then textarea[name]
      const input = container.querySelector(`input[name="${f.name}"]`) as HTMLInputElement | null;
      if (input) {
        return { name: f.name, type: input.getAttribute('type') ?? 'text', tag: 'input' };
      }

      const select = container.querySelector(`select[name="${f.name}"]`);
      if (select) {
        return { name: f.name, type: 'select', tag: 'select' };
      }

      const textarea = container.querySelector(`textarea[name="${f.name}"]`);
      if (textarea) {
        return { name: f.name, type: 'textarea', tag: 'textarea' };
      }

      // Try by data-field attribute
      const dataField = container.querySelector(`[data-field="${f.name}"] input`) as HTMLInputElement | null;
      if (dataField) {
        return { name: f.name, type: dataField.getAttribute('type') ?? 'text', tag: 'input' };
      }

      return { name: f.name, type: 'not-found', tag: 'none' };
    });
  }, { selector: containerSelector, fields: expectedFields });

  const mismatches: FieldTypeMismatch[] = [];
  let correctCount = 0;
  let totalChecked = 0;

  for (let i = 0; i < expectedFields.length; i++) {
    const expected = expectedFields[i];
    const actual = actualTypes[i];
    if (!actual || actual.type === 'not-found') continue;

    totalChecked++;
    const schemaType = expected.schemaType.toLowerCase();

    // Select elements are correct for enum/string fields with values
    if (actual.tag === 'select') {
      correctCount++;
      continue;
    }

    // Textarea is fine for string/text fields
    if (actual.tag === 'textarea' && (schemaType === 'string' || schemaType === 'text')) {
      correctCount++;
      continue;
    }

    // Check against the mapping
    const allowedTypes = SCHEMA_TO_HTML_TYPE[schemaType];
    if (!allowedTypes) {
      // Unknown schema type — assume any input type is fine
      correctCount++;
      continue;
    }

    if (allowedTypes.includes(actual.type)) {
      correctCount++;
    } else {
      mismatches.push({
        fieldName: expected.name,
        schemaType: expected.schemaType,
        expectedHtmlType: allowedTypes[0],
        actualHtmlType: actual.type,
      });
    }
  }

  return {
    allCorrect: mismatches.length === 0,
    totalChecked,
    correctCount,
    mismatches,
  };
}
