/**
 * Sentinel intent validation — fixed code, no LLM.
 *
 * Validates only what the Sentinel itself must guarantee before spending an
 * EquiRoute call: a syntactically plausible ticker and decimal-string money /
 * percentage fields that match EquiRoute's own decimal grammar.
 *
 * It deliberately does NOT decide which tickers exist, which representations
 * are canonical, or whether a mandate is well-formed — EquiRoute is the
 * authority for all three. An unknown-but-syntactically-valid ticker is sent
 * to EquiRoute and comes back as `UNSUPPORTED_TICKER`.
 */

import type { ExecutionMandateInput, SentinelIntent } from "./types.js";

/** EquiRoute's decimal grammar — equiroute/src/modules/routing/decimal.ts:17. */
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/u;

/** Conservative ticker syntax; EquiRoute decides actual support. */
const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/u;

/** EquiRoute's own slippage bound — equiroute/src/modules/preparation/prepare.ts:93. */
const MAX_SLIPPAGE_PERCENT = 50;

/** EquiRoute's `/api/policy/evaluate` default — preview.ts via route.ts:11. */
export const DEFAULT_SLIPPAGE_PERCENT = "0.5";

export class SentinelInputError extends Error {
  override readonly name = "SentinelInputError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * Accept a decimal string, or a number whose `String()` form is already an
 * exact decimal (so `1e21` / `NaN` / `Infinity` are rejected rather than
 * silently reinterpreted).
 */
function decimalString(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SentinelInputError(field, `${field} must be a finite number`);
    }
    const text = String(value);
    if (!DECIMAL.test(text)) {
      throw new SentinelInputError(
        field,
        `${field} must be expressible as a plain decimal string; got ${text}`,
      );
    }
    return text;
  }
  if (typeof value !== "string") {
    throw new SentinelInputError(
      field,
      `${field} must be a decimal string (got ${typeof value})`,
    );
  }
  const text = value.trim();
  if (!DECIMAL.test(text)) {
    throw new SentinelInputError(
      field,
      `${field} must be a decimal string; got ${JSON.stringify(value)}`,
    );
  }
  return text;
}

function assertPositive(text: string, field: string): void {
  // DECIMAL already matched, so a leading '-' or an all-zero magnitude is the
  // only way to be non-positive.
  if (text.startsWith("-") || /^[+-]?0+(?:\.0+)?$/u.test(text)) {
    throw new SentinelInputError(field, `${field} must be greater than zero`);
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SentinelInputError(field, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate an untrusted Sentinel request into a {@link SentinelIntent}.
 *
 * Throws {@link SentinelInputError} on bad input — the caller turns that into
 * a safe error report, never into a fabricated opportunity.
 */
export function validateSentinelIntent(input: unknown): SentinelIntent {
  const raw = asRecord(input, "intent");

  if (typeof raw.ticker !== "string") {
    throw new SentinelInputError("ticker", "ticker is required and must be a string");
  }
  const ticker = raw.ticker.trim().toUpperCase();
  if (ticker === "") {
    throw new SentinelInputError("ticker", "ticker is required");
  }
  if (!TICKER.test(ticker)) {
    throw new SentinelInputError(
      "ticker",
      `ticker must look like an equity symbol; got ${JSON.stringify(raw.ticker)}`,
    );
  }

  if (raw.notionalUsd === undefined || raw.notionalUsd === null) {
    throw new SentinelInputError("notionalUsd", "notionalUsd is required");
  }
  const notionalUsd = decimalString(raw.notionalUsd, "notionalUsd");
  assertPositive(notionalUsd, "notionalUsd");

  const slippagePercent =
    raw.slippagePercent === undefined || raw.slippagePercent === null
      ? DEFAULT_SLIPPAGE_PERCENT
      : decimalString(raw.slippagePercent, "slippagePercent");
  assertPositive(slippagePercent, "slippagePercent");
  if (Number(slippagePercent) > MAX_SLIPPAGE_PERCENT) {
    throw new SentinelInputError(
      "slippagePercent",
      `slippagePercent must be <= ${MAX_SLIPPAGE_PERCENT}`,
    );
  }

  const intent: SentinelIntent = { ticker, notionalUsd, slippagePercent };

  // The mandate is EquiRoute's to validate. Only its container shape is
  // checked here so a non-object cannot be forwarded as a mandate.
  if (raw.mandate !== undefined && raw.mandate !== null) {
    intent.mandate = asRecord(raw.mandate, "mandate") as ExecutionMandateInput;
  }

  return intent;
}
