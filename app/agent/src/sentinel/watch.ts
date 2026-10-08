/** Deterministic Market Watch specification and evaluator. */
import type { ExecutionMandateInput, SentinelReport } from "./types.js";

export const MARKET_WATCH_SKILL = "evaluate_market_watch";
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/u;

export type MarketWatch = {
  version: "1";
  ticker: string;
  notionalUsd: string;
  slippagePercent: string;
  mandate?: ExecutionMandateInput;
  conditions: {
    selectedProvider?: string;
    maximumEffectiveUsdPerShare?: string;
    minimumUnderlyingShares?: string;
    marketRegimes?: string[];
    requirePolicyOutcome?: Array<"allowed" | "confirmation_required">;
    requireExecutableAlternatives?: number;
    providerAvailability?: { provider: string; required: boolean };
  };
};

export type WatchConditionResult = {
  id: string;
  matched: boolean;
  observed: string | number | boolean | null;
  required: string | number | boolean;
  reason: string;
};

export type WatchEvaluation = {
  matched: boolean;
  evaluatedAt: string;
  conditions: WatchConditionResult[];
  report: SentinelReport;
  authorization: "none";
  requiresUserReviewInEquiRoute: true;
};

export type WatchDeliverable = {
  kind: "equiroute_market_watch";
  watch: MarketWatch;
  evaluation: WatchEvaluation;
  authorization: "none";
  explanation: string;
};

export class MarketWatchInputError extends Error {
  override readonly name = "MarketWatchInputError";
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

function decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value.trim())) {
    throw new MarketWatchInputError(field, `${field} must be a decimal string`);
  }
  return value.trim();
}

function positive(value: string, field: string): void {
  if (value.startsWith("-") || /^\+?0+(?:\.0+)?$/u.test(value)) {
    throw new MarketWatchInputError(field, `${field} must be positive`);
  }
}

function cmpDecimal(a: string, b: string): number {
  const normal = (value: string): [boolean, string, string] => {
    const negative = value.startsWith("-");
    const unsigned = value.replace(/^[+-]/u, "");
    const [whole, fraction = ""] = unsigned.split(".");
    return [negative, whole.replace(/^0+(?=\d)/u, ""), fraction.replace(/0+$/u, "")];
  };
  const [an, aw, af] = normal(a);
  const [bn, bw, bf] = normal(b);
  if (an !== bn) return an ? -1 : 1;
  const sign = an ? -1 : 1;
  if (aw.length !== bw.length) return (aw.length > bw.length ? 1 : -1) * sign;
  if (aw !== bw) return (aw > bw ? 1 : -1) * sign;
  const max = Math.max(af.length, bf.length);
  const ap = af.padEnd(max, "0");
  const bp = bf.padEnd(max, "0");
  return (ap === bp ? 0 : ap > bp ? 1 : -1) * sign;
}

export function validateMarketWatch(input: unknown): MarketWatch {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MarketWatchInputError("watch", "watch must be an object");
  }
  const value = input as Record<string, unknown>;
  if (value.version !== "1") throw new MarketWatchInputError("version", 'version must be "1"');
  const ticker = typeof value.ticker === "string" ? value.ticker.trim().toUpperCase() : "";
  if (!ticker) throw new MarketWatchInputError("ticker", "ticker is required");
  const notionalUsd = decimal(value.notionalUsd, "notionalUsd");
  positive(notionalUsd, "notionalUsd");
  const slippagePercent = decimal(value.slippagePercent, "slippagePercent");
  positive(slippagePercent, "slippagePercent");
  if (value.mandate !== undefined && (value.mandate === null || typeof value.mandate !== "object" || Array.isArray(value.mandate))) {
    throw new MarketWatchInputError("mandate", "mandate must be an object");
  }
  const raw = value.conditions;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MarketWatchInputError("conditions", "conditions must be an object");
  }
  const conditions = raw as Record<string, unknown>;
  const out: MarketWatch["conditions"] = {};
  if (conditions.selectedProvider !== undefined) {
    if (typeof conditions.selectedProvider !== "string" || !conditions.selectedProvider.trim()) throw new MarketWatchInputError("conditions.selectedProvider", "selectedProvider must be a non-empty string");
    out.selectedProvider = conditions.selectedProvider.trim().toLowerCase();
  }
  if (conditions.maximumEffectiveUsdPerShare !== undefined) {
    const value = decimal(conditions.maximumEffectiveUsdPerShare, "conditions.maximumEffectiveUsdPerShare");
    positive(value, "conditions.maximumEffectiveUsdPerShare"); out.maximumEffectiveUsdPerShare = value;
  }
  if (conditions.minimumUnderlyingShares !== undefined) {
    const value = decimal(conditions.minimumUnderlyingShares, "conditions.minimumUnderlyingShares");
    positive(value, "conditions.minimumUnderlyingShares"); out.minimumUnderlyingShares = value;
  }
  if (conditions.marketRegimes !== undefined) {
    if (!Array.isArray(conditions.marketRegimes) || conditions.marketRegimes.some((v) => typeof v !== "string")) throw new MarketWatchInputError("conditions.marketRegimes", "marketRegimes must be string[]");
    out.marketRegimes = conditions.marketRegimes.map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (!out.marketRegimes.length) throw new MarketWatchInputError("conditions.marketRegimes", "marketRegimes must not be empty");
  }
  if (conditions.requirePolicyOutcome !== undefined) {
    if (!Array.isArray(conditions.requirePolicyOutcome) || conditions.requirePolicyOutcome.some((v) => v !== "allowed" && v !== "confirmation_required")) throw new MarketWatchInputError("conditions.requirePolicyOutcome", "requirePolicyOutcome contains an unsupported outcome");
    out.requirePolicyOutcome = [...conditions.requirePolicyOutcome] as Array<"allowed" | "confirmation_required">;
  }
  if (conditions.requireExecutableAlternatives !== undefined) {
    if (typeof conditions.requireExecutableAlternatives !== "number" || !Number.isInteger(conditions.requireExecutableAlternatives) || conditions.requireExecutableAlternatives < 0) throw new MarketWatchInputError("conditions.requireExecutableAlternatives", "threshold must be a non-negative integer");
    out.requireExecutableAlternatives = conditions.requireExecutableAlternatives;
  }
  if (conditions.providerAvailability !== undefined) {
    const p = conditions.providerAvailability;
    if (p === null || typeof p !== "object" || Array.isArray(p)) throw new MarketWatchInputError("conditions.providerAvailability", "providerAvailability must be an object");
    const provider = (p as Record<string, unknown>).provider;
    const required = (p as Record<string, unknown>).required;
    if (typeof provider !== "string" || !provider.trim() || typeof required !== "boolean") throw new MarketWatchInputError("conditions.providerAvailability", "providerAvailability requires provider and boolean required");
    out.providerAvailability = { provider: provider.trim().toLowerCase(), required };
  }
  if (!Object.keys(out).length) throw new MarketWatchInputError("conditions", "at least one condition is required");
  return {
    version: "1", ticker, notionalUsd, slippagePercent,
    ...(value.mandate ? { mandate: value.mandate as ExecutionMandateInput } : {}),
    conditions: out,
  };
}

function result(id: string, matched: boolean, observed: string | number | boolean | null, required: string | number | boolean, reason: string): WatchConditionResult {
  return { id, matched, observed, required, reason };
}

export function evaluateMarketWatch(watch: MarketWatch, report: SentinelReport, evaluatedAt = new Date().toISOString()): WatchEvaluation {
  const conditions: WatchConditionResult[] = [];
  const c = watch.conditions;
  const selected = report.selectedRepresentation;
  if (c.selectedProvider !== undefined) {
    const observed = selected?.provider ?? null;
    conditions.push(result("selected_provider", observed === c.selectedProvider, observed, c.selectedProvider, observed === c.selectedProvider ? "Selected provider matches." : "Selected provider does not match."));
  }
  if (c.maximumEffectiveUsdPerShare !== undefined) {
    const observed = selected?.effectiveUsdPerShare ?? null;
    const matched = observed !== null && cmpDecimal(observed, c.maximumEffectiveUsdPerShare) <= 0;
    conditions.push(result("maximum_effective_usd_per_share", matched, observed, c.maximumEffectiveUsdPerShare, matched ? "Selected effective USD/share is within the maximum." : "Selected effective USD/share is unavailable or above the maximum."));
  }
  if (c.minimumUnderlyingShares !== undefined) {
    const observed = selected?.normalizedUnderlyingShares ?? null;
    const matched = observed !== null && cmpDecimal(observed, c.minimumUnderlyingShares) >= 0;
    conditions.push(result("minimum_underlying_shares", matched, observed, c.minimumUnderlyingShares, matched ? "Selected underlying shares meet the minimum." : "Selected underlying shares are unavailable or below the minimum."));
  }
  if (c.marketRegimes !== undefined) {
    const observed = report.market.regime;
    const matched = observed !== null && c.marketRegimes.includes(observed);
    conditions.push(result("market_regime", matched, observed, c.marketRegimes.join(","), matched ? "Market regime is permitted." : "Market regime is not permitted or unavailable."));
  }
  if (c.requirePolicyOutcome !== undefined) {
    const observed = report.policy.outcome;
    const matched = c.requirePolicyOutcome.includes(observed as "allowed" | "confirmation_required");
    conditions.push(result("policy_outcome", matched, observed, c.requirePolicyOutcome.join(","), matched ? "Policy outcome is permitted." : "Policy outcome is not permitted."));
  }
  if (c.requireExecutableAlternatives !== undefined) {
    const observed = report.alternatives.filter((a) => a.eligible).length;
    conditions.push(result("executable_alternatives", observed >= c.requireExecutableAlternatives, observed, c.requireExecutableAlternatives, observed >= c.requireExecutableAlternatives ? "Executable alternative threshold met." : "Executable alternative threshold not met."));
  }
  if (c.providerAvailability !== undefined) {
    const alternative = report.alternatives.find((a) => a.provider === c.providerAvailability?.provider);
    const observed = alternative?.eligible ?? (selected?.provider === c.providerAvailability.provider);
    const matched = observed === c.providerAvailability.required;
    const reason = matched
      ? "Provider availability matches."
      : alternative?.rejectionClass === "NO_EXECUTABLE_LIQUIDITY"
        ? "Provider is unavailable due to definitive liquidity failure."
        : "Provider availability does not match.";
    conditions.push(result("provider_availability", matched, observed, c.providerAvailability.required, reason));
  }
  return {
    matched: conditions.every((condition) => condition.matched), evaluatedAt, conditions, report,
    authorization: "none", requiresUserReviewInEquiRoute: true,
  };
}

export function watchDeliverable(watch: MarketWatch, evaluation: WatchEvaluation, explanation: string): WatchDeliverable {
  return { kind: "equiroute_market_watch", watch, evaluation, authorization: "none", explanation };
}

export function watchToPrompt(watch: MarketWatch): string { return JSON.stringify({ skill: MARKET_WATCH_SKILL, ...watch }); }


