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


/** Whether text clearly describes a Sentinel deliverable. */
export function isSentinelJobText(text: string): boolean {
  return /\bequiroute\s+(?:market\s+)?sentinel\b/iu.test(text) ||
    /\bsentinel\s+(?:assessment|report|analysis|market-watch)\b/iu.test(text);
}

/**
 * Extract an explicit ticker + USD notional from Sentinel job text.
 *
 * Two tiers, both fixed code:
 *  1. Adjacency forms where the amount and symbol appear together
 *     (`$10 NVDA`, `NVDA $10`, `$10 of NVDA`, `10 USD NVDA`,
 *     `NVDA with a $10 notional`).
 *  2. Independently labelled fields (`ticker: NVDA` … `notional of $10`).
 *
 * Nothing is inferred: without BOTH an explicit symbol and an explicit USD
 * amount this returns null and the caller must not invent an analysis.
 */
export function sentinelIntentFromJobText(
  text: string,
): Record<string, unknown> | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  /** [pattern, amountGroup, tickerGroup] */
  const adjacency: Array<[RegExp, 1 | 2, 1 | 2]> = [
    // "$10 NVDA", "$10 of NVDA", "a $10 NVDA tokenized-equity opportunity"
    [/\$\s*(\d+(?:\.\d+)?)\s+(?:of\s+)?([A-Z][A-Z0-9.-]{0,11})\b/u, 1, 2],
    // "NVDA $10", "NVDA with a $10 notional"
    [
      /\b([A-Z][A-Z0-9.-]{0,11})\s+(?:with\s+(?:a\s+)?)?\$\s*(\d+(?:\.\d+)?)\b/u,
      2,
      1,
    ],
    // "10 USD NVDA", "10 USD of NVDA"
    [/\b(\d+(?:\.\d+)?)\s*USD\s+(?:of\s+)?([A-Z][A-Z0-9.-]{0,11})\b/iu, 1, 2],
  ];

  let ticker: string | null = null;
  let notional: string | null = null;

  for (const [pattern, amountGroup, tickerGroup] of adjacency) {
    const match = pattern.exec(text);
    if (!match) continue;
    const candidateTicker = match[tickerGroup];
    const candidateAmount = match[amountGroup];
    if (candidateTicker === undefined || candidateAmount === undefined) continue;
    // Reject prose words that merely look symbol-shaped in a case-insensitive
    // match (e.g. "USD" itself); require an uppercase symbol.
    if (!/^[A-Z][A-Z0-9.-]*$/u.test(candidateTicker)) continue;
    ticker = candidateTicker;
    notional = candidateAmount;
    break;
  }

  // Tier 2 — independently labelled fields.
  ticker ??=
    /(?:"?ticker"?|"?symbol"?)\s*(?:[:=]|is)?\s*"?([A-Z][A-Z0-9.-]{0,11})"?/u.exec(
      text,
    )?.[1] ?? null;
  notional ??=
    /(?:"?notional(?:Usd)?"?)\s*(?:[:=]|is|of)?\s*"?\$?\s*(\d+(?:\.\d+)?)"?/iu.exec(
      text,
    )?.[1] ??
    /\$\s*(\d+(?:\.\d+)?)/u.exec(text)?.[1] ??
    null;

  if (ticker === null || notional === null) return null;

  const slippage =
    /(?:"?slippage(?:Percent)?"?)\s*(?:[:=]|is|of)?\s*"?(\d+(?:\.\d+)?)"?/iu.exec(
      text,
    )?.[1] ??
    /(\d+(?:\.\d+)?)\s*%\s*slippage/iu.exec(text)?.[1] ??
    null;

  return {
    ticker: ticker.toUpperCase(),
    notionalUsd: notional,
    ...(slippage !== null ? { slippagePercent: slippage } : {}),
  };
}

/** Extract structured fields from task and terms strings, preferring explicit data. */
export function sentinelJobRequestFromPrompt(
  prompt: string,
): { sentinelJob: boolean; intent: Record<string, unknown> | null } {
  const direct = firstJsonObject(prompt);
  const task: string[] = [];
  const termTexts: string[] = [];
  if (isRecord(direct)) {
    if (typeof direct.task === "string") task.push(direct.task);
    if (typeof direct.task_description === "string") task.push(direct.task_description);
    if (typeof direct.terms === "string") termTexts.push(direct.terms);
    if (isRecord(direct.terms)) {
      for (const value of Object.values(direct.terms)) {
        if (typeof value === "string") termTexts.push(value);
      }
    }
  }
  const bodyText = [...task, ...termTexts].join("\n");
  const sentinelJob = isSentinelJobText(bodyText || prompt);
  if (!sentinelJob) return { sentinelJob: false, intent: null };

  const combined = [...task, ...termTexts].join("\n");
  return {
    sentinelJob: true,
    intent:
      sentinelIntentFromPayload(direct) ??
      sentinelIntentFromJobText(combined) ??
      sentinelIntentFromJobText(prompt),
  };
}

/** Scan a string for the first balanced JSON object and parse it. */
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
