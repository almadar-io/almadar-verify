import { VERIFICATION_DOM_ATTRS } from '@almadar/core';

const A = VERIFICATION_DOM_ATTRS;

export const hasAttr = (attr: string): string => `[${attr}]`;

export const attrEquals = (attr: string, value: string): string => `[${attr}="${value}"]`;

export const patternSelector = (pattern: string): string => attrEquals(A.pattern, pattern);

export const rowIdSelector = (rowId?: string): string =>
  rowId === undefined ? hasAttr(A.rowId) : attrEquals(A.rowId, rowId);

export const entityRowSelector = (entityId?: string): string =>
  `${hasAttr(A.entityRow)}${entityId === undefined ? '' : attrEquals(A.entityId, entityId)}`;

export const testIdSelector = (testId: string): string => attrEquals('data-testid', testId);

export const fieldNameSelector = (name: string): string => `[${A.fieldName}=${JSON.stringify(name)}]`;

export const eventSelector = (event: string): string => attrEquals(A.event, event);

export const ENTITY_ROW_SELECTOR =
  `${hasAttr(A.entityRow)}, ${hasAttr(A.entityId)}, ${patternSelector('data-grid')} tbody tr, ${patternSelector('data-list')} > *`;
