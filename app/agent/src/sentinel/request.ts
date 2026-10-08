/**
 * Sentinel request detection for text carriers.
 *
 * The A2A and MCP faces receive a structured payload directly. The ERC-8183
 * delivery hook and the FREE x402 seller route, however, hand `runWork` a
 * PROMPT STRING: the ERC-8183 job spec is wrapped in `JOB CONTEXT:\n{...}`, and
 * the b402 seller forwards `?prompt=` / `{"prompt": "..."}` / the raw body
 * verbatim (studio-runtime b402 `promptFrom`).
 *
 * This module recognises a Sentinel request inside such a string so the
 * deterministic analysis path runs instead of a free-form LLM answer. Detection
 * is intentionally narrow: an ordinary job must still reach the LLM.
 *
 * A payload qualifies when it is a JSON object that either
 *   - names the Sentinel skill/tool explicitly, or
 *   - carries both `ticker` and `notionalUsd`,
 * optionally nested under `sentinel`, `intent`, `input`, `request` or `params`.
 */

export const SENTINEL_SKILL = "analyze_tokenized_equity";
export const MARKET_WATCH_SKILL = "evaluate_market_watch";

/** Accepted aliases for the skill/kind marker. */
const SKILL_ALIASES = new Set([
  SENTINEL_SKILL,
  "analyse_tokenized_equity",
  "sentinel",
  "market_sentinel",
  "sentinel_report",
  MARKET_WATCH_SKILL,
  "equiroute_market_watch",
]);

const NESTED_KEYS = ["sentinel", "intent", "input", "request", "params"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function namesSentinel(record: Record<string, unknown>): boolean {
  for (const field of ["skill", "tool", "kind", "type", "operation"]) {
    const value = record[field];
    if (typeof value === "string" && SKILL_ALIASES.has(value.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

function hasIntentFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.ticker === "string" &&
    record.ticker.trim() !== "" &&
    record.notionalUsd !== undefined &&
    record.notionalUsd !== null
  );
}

/** Lift the intent object out of a (possibly nested) envelope. */
function extractIntent(record: Record<string, unknown>): Record<string, unknown> | null {
  if (hasIntentFields(record)) return record;
  for (const nestedKey of NESTED_KEYS) {
    const nested = record[nestedKey];
    if (isRecord(nested) && hasIntentFields(nested)) return nested;
  }
  // Explicitly named but malformed: return the envelope so validation produces
  // a precise input error instead of silently falling through to the LLM.
  if (namesSentinel(record)) {
    for (const nestedKey of NESTED_KEYS) {
      const nested = record[nestedKey];
      if (isRecord(nested)) return nested;
    }
    return record;
  }
  return null;
}

/**
 * Pull a Sentinel intent out of an arbitrary structured payload.
 * Returns null when the payload is not a Sentinel request.
 */
export function sentinelIntentFromPayload(
  payload: unknown,
): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  return extractIntent(payload);
}

export function marketWatchFromPayload(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const marker = ["skill", "tool", "kind", "type", "operation"].some((field) => payload[field] === MARKET_WATCH_SKILL || payload[field] === "equiroute_market_watch");
  if (!marker) return null;
  const copy = { ...payload };
  delete copy.skill; delete copy.tool; delete copy.kind; delete copy.type; delete copy.operation;
  return copy;
}


function firstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function watchFromPrompt(prompt: string): Record<string, unknown> | null {
  const direct = firstJsonObject(prompt);
  if (direct !== null) {
    const watch = marketWatchFromPayload(direct);
    if (watch !== null) return watch;
    if (isRecord(direct)) {
      for (const field of ["task", "terms"]) {
        const nested = direct[field];
        if (isRecord(nested)) {
          const found = marketWatchFromPayload(nested);
          if (found !== null) return found;
        }
        if (typeof nested === "string") {
          const found = marketWatchFromPayload(firstJsonObject(nested));
          if (found !== null) return found;
        }
      }
    }
  }
  return null;
}

/**
 * Recognise a Sentinel request inside a prompt string (ERC-8183 job context,
 * x402 body, or plain JSON). Returns null when the prompt is ordinary work.
 */
export function sentinelIntentFromPrompt(
  prompt: string,
): Record<string, unknown> | null {
  const direct = firstJsonObject(prompt);
  if (direct !== null) {
    const watch = marketWatchFromPayload(direct);
    if (watch !== null) return watch;
    const intent = sentinelIntentFromPayload(direct);
    if (intent !== null) return intent;
    // ERC-8183 job spec: {"task": "...", "terms": {...}} — the Sentinel request
    // may live in either half.
    if (isRecord(direct)) {
      for (const field of ["task", "terms"]) {
        const value = direct[field];
        if (isRecord(value)) {
          const nested = sentinelIntentFromPayload(value);
          if (nested !== null) return nested;
        }
        if (typeof value === "string") {
          const parsed = firstJsonObject(value);
          const nested = sentinelIntentFromPayload(parsed);
          if (nested !== null) return nested;
        }
      }
    }
  }
  return null;
}
