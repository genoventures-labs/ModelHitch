/**
 * HTTP header helpers. Kept tiny and dependency-free so every adapter
 * (OpenAI-compatible, Anthropic, Gemini, …) can share them.
 */

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Supports both forms the header allows:
 * - `Retry-After: 45` — seconds until retry
 * - `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` — HTTP-date
 *
 * Returns `undefined` for absent, malformed, or already-expired values.
 * The caller decides how to treat "none" (typically: keep the default
 * behavior — instant failover).
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Delta-seconds (allows fractions per the RFC; round up to whole ms).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isNaN(seconds) || seconds < 0) return undefined;
    return Math.ceil(seconds * 1000);
  }
  // HTTP-date.
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const ms = date - Date.now();
  return ms > 0 ? ms : undefined;
}