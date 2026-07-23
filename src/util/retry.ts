/**
 * Retry utility with exponential backoff.
 *
 * @packageDocumentation
 */

/**
 * Retry an async operation with exponential backoff.
 *
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param baseDelayMs - Base delay in ms before first retry (default: 500)
 * @returns Result of the successful call
 * @throws Last error if all retries exhausted
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
