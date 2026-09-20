export type PromiseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * Attach both fulfillment and rejection handlers immediately.
 *
 * This is important for Playwright event promises: another awaited operation
 * may fail before the event promise is awaited. Keeping the rejection handled
 * prevents it from becoming an unhandled rejection during browser cleanup.
 */
export function capturePromiseOutcome<T>(
  promise: Promise<T>,
): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
