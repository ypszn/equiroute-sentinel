/**
 * Sentinel types + EquiRoute wire schemas.
 *
 * The EquiRoute schemas below MIRROR the real contracts in the sibling
 * `../equiroute` repository (verified against live responses). They are
 * deliberately lenient about fields the Sentinel does not read (`.passthrough()`,
 * `unknown` for `raw`) and strict about the fields it DOES read, so a contract
 * drift surfaces as a schema error instead of a silently wrong report.
 *
 * Source of truth (read-only inspection):
 *   equiroute/src/modules/routing/types.ts      NormalizedQuote, QuoteRejection,
 *                                               PolicyRejectedRoute
 *   equiroute/src/modules/routing/api-types.ts  RouteApiResponse
 *   equiroute/src/modules/policy/engine.ts      ExecutionMandate, PolicyDecision
 *   equiroute/src/modules/policy/preview.ts     /api/policy/evaluate 200 body
 *   equiroute/src/modules/registry/types.ts     MarketRegime, MarketContext
 *
 * NOTHING here recomputes an EquiRoute number. Every numeric value is a
 * decimal STRING carried through verbatim.
 */

import { z } from "zod";

// ── EquiRoute enums (verbatim) ───────────────────────────────────────────────

/** equiroute/src/modules/registry/types.ts:3 */
export const EQUIROUTE_PROVIDERS = ["ondo", "bstock", "xstock"] as const;

/** equiroute/src/modules/registry/types.ts:25 — note: `postmarket`, not `afterhours`. */
export const MARKET_REGIMES = [
  "regular",
  "premarket",
  "postmarket",
  "offhours",
  "closed",
  "paused",
  "restricted",
  "unknown",
] as const;

/** equiroute/src/modules/policy/engine.ts:23 */
export const POLICY_OUTCOMES = [
  "allowed",
  "confirmation_required",
  "blocked",
] as const;

export type EquiRouteProvider = (typeof EQUIROUTE_PROVIDERS)[number];
export type MarketRegime = (typeof MARKET_REGIMES)[number];
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

// ── EquiRoute wire schemas ───────────────────────────────────────────────────

const decimalString = z.string();

/** equiroute NormalizedQuote. Only the consumed fields are constrained. */
export const normalizedQuoteSchema = z
  .object({
    provider: z.string(),
    symbol: z.string(),
    contractAddress: z.string(),
    available: z.boolean(),
    executionMode: z.string().nullable().optional(),
    outputTokenAmount: decimalString.nullable().optional(),
    estimatedUnderlyingShares: decimalString.nullable().optional(),
    effectiveUsdPerShare: decimalString.nullable().optional(),
    priceImpactPercent: decimalString.nullable().optional(),
    ratioStatus: z.string().nullable().optional(),
    failureCode: z.string().nullable().optional(),
    failureReason: z.string().nullable().optional(),
  })
  .passthrough();

export type NormalizedQuote = z.infer<typeof normalizedQuoteSchema>;

/** equiroute QuoteRejection */
export const quoteRejectionSchema = z
  .object({
    provider: z.string().nullable(),
    symbol: z.string(),
    reason: z.string(),
    code: z.string().nullable().optional(),
  })
  .passthrough();

export type QuoteRejection = z.infer<typeof quoteRejectionSchema>;

/** equiroute PolicyRejectedRoute */
export const policyRejectedRouteSchema = z
  .object({
    provider: z.string(),
    symbol: z.string(),
    reasonCode: z.string(),
    reason: z.string(),
    stage: z.string(),
  })
  .passthrough();

export type PolicyRejectedRoute = z.infer<typeof policyRejectedRouteSchema>;

/** equiroute MarketContext (UnderlyingMarketStatus & { regime }) */
export const marketContextSchema = z
  .object({
    regime: z.string().nullable().optional(),
    marketStatus: z.string().nullable().optional(),
    openState: z.boolean().nullable().optional(),
    reasonCode: z.string().nullable().optional(),
    reasonMsg: z.string().nullable().optional(),
  })
  .passthrough();

export type MarketContext = z.infer<typeof marketContextSchema>;

export const routeIntentSchema = z
  .object({
    ticker: z.string(),
    notionalUsd: z.string(),
    userWalletAddress: z.string().nullable().optional(),
  })
  .passthrough();

/** `POST /api/route` 200 body — equiroute RouteApiResponse. */
export const routeResultSchema = z
  .object({
    intent: routeIntentSchema,
    marketContext: marketContextSchema.nullable(),
    representationsEvaluated: z.number(),
    quotes: z.array(normalizedQuoteSchema),
    selected: normalizedQuoteSchema.nullable(),
    rejected: z.array(quoteRejectionSchema),
    policyRejectedRoutes: z.array(policyRejectedRouteSchema).optional(),
    explanation: z.array(z.string()),
  })
  .passthrough();

export type RouteResult = z.infer<typeof routeResultSchema>;

/** equiroute PolicyDecision */
export const policyDecisionSchema = z
  .object({
    outcome: z.enum(POLICY_OUTCOMES),
    checks: z
      .array(
        z
          .object({
            id: z.string(),
            stage: z.string(),
            status: z.string(),
            reason: z.string(),
            observed: z.string().nullable().optional(),
            limit: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    blockingReasons: z.array(z.string()),
    confirmationReasons: z.array(z.string()),
  })
  .passthrough();

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

/** `POST /api/policy/evaluate` 200 body — inferred return of evaluatePolicyPreview. */
export const policyResultSchema = z
  .object({
    mandate: z.unknown().optional(),
    intent: routeIntentSchema,
    marketContext: marketContextSchema.nullable(),
    quotes: z.array(normalizedQuoteSchema),
    selected: normalizedQuoteSchema.nullable(),
    rejected: z.array(quoteRejectionSchema),
    policyRejectedRoutes: z.array(policyRejectedRouteSchema).optional(),
    /**
     * ABSENT for an unsupported ticker: equiroute's `routeIntent` returns
     * early before evaluating policy. A missing decision is never treated as
     * an allow.
     */
    policyDecision: policyDecisionSchema.optional(),
    evaluatedAt: z.string().optional(),
  })
  .passthrough();

export type PolicyResult = z.infer<typeof policyResultSchema>;

/** `{ error, detail? }` — equiroute RouteApiError, shared by every endpoint. */
export const equiRouteErrorBodySchema = z
  .object({ error: z.string(), detail: z.string().optional() })
  .passthrough();

// ── Sentinel request types ───────────────────────────────────────────────────

/**
 * Execution mandate input. Passed through to EquiRoute VERBATIM — EquiRoute
 * owns mandate validation and policy evaluation, so the Sentinel deliberately
 * does NOT re-implement either. `undefined` means "EquiRoute's default
 * mandate".
 */
export type ExecutionMandateInput = Record<string, unknown>;

export type SentinelIntent = {
  ticker: string;
  notionalUsd: string;
  slippagePercent: string;
  mandate?: ExecutionMandateInput;
};

/** Input to {@link EquiRouteClient.evaluatePolicy}. */
export type PolicyInput = {
  ticker: string;
  notionalUsd: string;
  slippagePercent: string;
  mandate?: ExecutionMandateInput;
};

// ── Sentinel report ──────────────────────────────────────────────────────────

export const OPPORTUNITY_STATUSES = [
  "actionable",
  "needs_confirmation",
  "blocked",
  "unavailable",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * `"unavailable"` is NOT an EquiRoute verdict. It is used only when EquiRoute
 * returned no deterministic `policyDecision` at all (service unreachable,
 * non-2xx, malformed body, or an unsupported ticker that short-circuits before
 * policy evaluation). Reporting an EquiRoute-shaped outcome in that case would
 * fabricate a policy result.
 */
export type SentinelPolicyOutcome = PolicyOutcome | "unavailable";

export type SentinelSelectedRepresentation = {
  provider: string;
  symbol: string;
  contractAddress: string;
  executionMode: string | null;
  expectedOutput: string | null;
  normalizedUnderlyingShares: string | null;
  effectiveUsdPerShare: string | null;
};

/**
 * Why a representation is not eligible, normalised by the Sentinel so the
 * three fundamentally different cases are never conflated:
 *
 *  QUOTE_CONTEXT_ADDRESS_REQUIRED — the representation prices through RFQ and
 *      EquiRoute needs a quote-context address to return ANY quote. This is a
 *      Sentinel configuration gap, NOT an economic verdict: the representation
 *      must never be presented as worse, only as not compared.
 *  NO_EXECUTABLE_LIQUIDITY — EquiRoute reached the venue and there was not
 *      enough liquidity to fill. A real market outcome.
 *  POLICY_INELIGIBLE — the representation quoted fine; the active mandate
 *      excluded it. A real policy outcome.
 *  QUOTE_FAILED — any other upstream quote failure.
 */
export const REJECTION_CLASSES = [
  "QUOTE_CONTEXT_ADDRESS_REQUIRED",
  "NO_EXECUTABLE_LIQUIDITY",
  "POLICY_INELIGIBLE",
  "QUOTE_FAILED",
] as const;

export type RejectionClass = (typeof REJECTION_CLASSES)[number];

export type SentinelAlternative = {
  provider: string;
  symbol: string;
  eligible: boolean;
  rejectionReason?: string;
  /** EquiRoute's own code (`failureCode` or policy `reasonCode`), verbatim. */
  rejectionCode?: string | null;
  /** EquiRoute's policy `stage`, when the rejection came from the mandate. */
  rejectionStage?: string | null;
  /** Sentinel's normalised classification of the rejection. */
  rejectionClass?: RejectionClass;
  normalizedUnderlyingShares?: string | null;
  effectiveUsdPerShare?: string | null;
};

export type SentinelReport = {
  version: "1";

  generatedAt: string;

  intent: {
    ticker: string;
    notionalUsd: string;
    slippagePercent: string;
  };

  market: {
    regime: string | null;
    /** false when EquiRoute returned no market context at all. */
    available: boolean;
  };

  selectedRepresentation: SentinelSelectedRepresentation | null;

  alternatives: SentinelAlternative[];

  /**
   * Provenance for the read-only quote-context address.
   *
   * `addressUsed` is a PUBLIC address sent to EquiRoute only so RFQ
   * representations will return a readable quote. It is not an execution
   * wallet, not a Binance Agentic Wallet identity, and not a signer:
   * `executionAuthority` is the constant `false`.
   */
  quoteContext: {
    addressUsed: string | null;
    purpose: "read_only_quote_context";
    executionAuthority: false;
  };

  /**
   * Whether every canonical representation could actually be compared.
   *
 * `degraded` means at least one representation could not be given a definitive
   * quote result (e.g. missing quote context or a technical quote failure).
   * A definitive liquidity failure or mandate exclusion counts as evaluated,
   * and is not itself a degradation.
   */
  comparison: {
    status: "complete" | "degraded";
    totalRepresentations: number;
    evaluatedRepresentations: number;
    economicallyComparableRepresentations: number;
    unavailableRepresentations: number;
    /** `provider/symbol: CLASS` for each definitive unavailable representation. */
    unavailableBy: string[];
    /** `provider/symbol: CLASS` for each representation that degraded analysis. */
    degradedBy: string[];
  };

  policy: {
    outcome: SentinelPolicyOutcome;
    blockingReasons: string[];
    confirmationReasons: string[];
  };

  opportunity: {
    status: OpportunityStatus;
    reason: string;
  };

  /**
   * The execution boundary. Invariant for EVERY report the Sentinel produces:
   * the Sentinel never authorizes, prepares, signs, or broadcasts anything.
   * The user's Binance Agentic Wallet review happens separately, inside
   * EquiRoute.
   */
  execution: {
    authorization: "none";
    requiresUserReviewInEquiRoute: true;
  };

  /** Non-fatal degradations (e.g. route discovery failed, policy pass worked). */
  warnings: string[];
};

/** What the Sentinel hands back on every face (A2A, MCP, x402, ERC-8183). */
export type SentinelDeliverable = {
  report: SentinelReport;
  explanation: string;
};
