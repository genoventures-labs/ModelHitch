/** Parse JSON safely, falling back to `fallback` on empty input or parse errors. */
export function safeJsonParse<T>(text: string, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
