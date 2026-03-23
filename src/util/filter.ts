/**
 * Noise filters for console messages.
 *
 * Shared across orbital-verify, runtime-verify, and playground-test
 * to exclude browser/webpack/DevTools noise from error reports.
 *
 * @packageDocumentation
 */

/** Patterns that should be ignored from console errors */
const ERROR_NOISE_PATTERNS = [
  'favicon.ico',
  'net::ERR_',
  'the server responded with a status of 404',
  'Failed to load resource',
  'ERR_CONNECTION_REFUSED',
  'Encountered two children with the same key',
  'React does not recognize the',
  '[vite]',
] as const;

/** Patterns that should be ignored from console warnings */
const WARNING_NOISE_PATTERNS = [
  'DevTools',
  'React DevTools',
  'Download the React DevTools',
  'Warning: Each child in a list should have a unique',
  'set is server-side only, ignored on client',
  'persist is server-side only, ignored on client',
  'callService is server-side only, ignored on client',
  '[webpack-dev-server]',
  '[HMR]',
] as const;

/** Check if a console error message is noise (should be ignored) */
export function isNoiseError(text: string): boolean {
  return ERROR_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
}

/** Check if a console warning message is noise (should be ignored) */
export function isNoiseWarning(text: string): boolean {
  return WARNING_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
}
