/**
 * Sentinel runner — the `runWork` VALUE logic.
 *
 * This is the autonomous analysis/orchestration layer. It is NOT the
 * deterministic financial decision engine: EquiRoute remains the authority for
 * canonical representations, live quotes, normalization, market regime,
 * deterministic mandate evaluation and route selection. The Sentinel transports
 * that result, classifies it with a fixed rule table, and explains it.
 *
 *     Sentinel ──HTTPS──▶ EquiRoute ──deterministic result──▶ Sentinel Report
 *
 * Binance Agentic Wallet is NOT called from here. It stays a separate execution
 * boundary the user crosses later, by reviewing the opportunity in EquiRoute.
 *
 * Flow:
 *   1. validate the request                      (intent.ts, fixed code)
 *   2. call EquiRoute route discovery            POST /api/route
 *   3. obtain the deterministic selection        policy pass `selected`
 *   4. obtain the policy result                  POST /api/policy/evaluate
 *   5. capture market regime                     marketContext.regime
 *   6. capture alternative representations        quotes[]
 *   7. preserve route rejection reasons           rejected[] / failureReason
 *   8. create the structured Sentinel Report      report.ts
 *   9. generate the explanation                   explain.ts (numbers from code)
 *  10. return the deliverable                     SentinelDeliverable
 *
 * Nothing here executes, prepares, signs or broadcasts anything.
 */

import {
  EquiRouteError,
  type EquiRouteClient,
  HttpEquiRouteClient,
} from "./equirouteClient.js";
import { explainSentinelReport, renderSentinelReport, type CommentaryModel } from "./explain.js";
import { SentinelInputError, validateSentinelIntent } from "./intent.js";
import {
  buildSentinelReport,
  buildUnavailableReport,
  type Clock,
} from "./report.js";
import type {
  PolicyResult,
  RouteResult,
  SentinelDeliverable,
  SentinelIntent,
  SentinelReport,
} from "./types.js";
import {
  evaluateMarketWatch as evaluateWatchReport,
  validateMarketWatch,
  type MarketWatch,
  type WatchEvaluation,
} from "./watch.js";

export interface SentinelRunnerOptions {
  /** EquiRoute transport. Defaults to the env-configured HTTP client. */
  readonly client?: EquiRouteClient;
  /** Optional commentary model. Omit to return the deterministic body only. */
  readonly model?: CommentaryModel | null;
  readonly clock?: Clock;
}

/** Thrown only for caller-input problems; EquiRoute faults become reports. */
export { SentinelInputError };

export interface SentinelRunner {
  /** Analyse a validated or raw request and return the full deliverable. */
  analyze(
    request: unknown,
    opts?: { sessionId?: string; abortSignal?: AbortSignal },
  ): Promise<SentinelDeliverable>;
  /** Deliverable rendered for a text-only carrier (ERC-8183 / x402 body). */
  analyzeToText(
    request: unknown,
    opts?: { sessionId?: string; abortSignal?: AbortSignal },
  ): Promise<string>;
  evaluateWatch(
    request: unknown,
    opts?: { sessionId?: string; abortSignal?: AbortSignal },
  ): Promise<{
    watch: MarketWatch;
    evaluation: WatchEvaluation;
    explanation: string;
    commentaryStatus?: string;
  }>;
}

/** Marker that separates the prose explanation from the machine-readable report. */
export const REPORT_DELIMITER = "--- SENTINEL REPORT (JSON) ---";

/** Render a deliverable for a text-only carrier without losing the structure. */
export function renderDeliverableText(deliverable: SentinelDeliverable): string {
  return `${deliverable.explanation}\n\n${REPORT_DELIMITER}\n${JSON.stringify(
    deliverable.report,
    null,
    2,
  )}`;
}

export function createSentinelRunner(
  options: SentinelRunnerOptions = {},
): SentinelRunner {
  const client = options.client ?? new HttpEquiRouteClient();
  const model = options.model ?? null;

  async function analyze(
    request: unknown,
    opts: { sessionId?: string; abortSignal?: AbortSignal } = {},
  ): Promise<SentinelDeliverable> {
    // 1 — validate. An input error is a safe report, not an exception on the
    // wire, so no face can turn bad input into a fabricated opportunity.
    let intent: SentinelIntent;
    try {
      intent = validateSentinelIntent(request);
    } catch (error) {
      if (!(error instanceof SentinelInputError)) throw error;
      const fallback: SentinelIntent = {
        ticker: readString(request, "ticker") ?? "",
        notionalUsd: readString(request, "notionalUsd") ?? "",
        slippagePercent: readString(request, "slippagePercent") ?? "",
      };
      const report = buildUnavailableReport(
        fallback,
        `Invalid Sentinel request (${error.field}): ${error.message}`,
        options.clock,
      );
      return { report, explanation: renderSentinelReport(report) };
    }

    // provenance must match the immutable address included in request bodies.
    const quoteContextAddress = client.quoteContextAddress();

    // 2 + 4 — both EquiRoute passes, SEQUENTIALLY.
    //
    // Each pass makes EquiRoute fan out a live quote per canonical
    // representation. Running the passes concurrently doubles that upstream
    // fan-out for one intent, which was observed to trip the upstream quote
    // provider and degrade an otherwise good report. Sequential keeps peak
    // upstream pressure at one pass's worth.
    //
    // The mandate-aware pass goes FIRST so that, if a quota or upstream limit
    // is hit, the authoritative deterministic verdict is the one we obtained.
    let policy: PolicyResult | null = null;
    let policyError: EquiRouteError | null = null;
    try {
      policy = await client.evaluatePolicy(intent);
    } catch (error) {
      policyError = asEquiRouteError(error);
    }

    let route: RouteResult | null = null;
    let routeError: EquiRouteError | null = null;
    try {
      route = await client.getRoute(intent);
    } catch (error) {
      routeError = asEquiRouteError(error);
    }

    // Never fabricate: if neither pass produced a result, report unavailable.
    if (route === null && policy === null) {
      const cause = policyError ?? routeError;
      const report = buildUnavailableReport(
        intent,
        cause !== null
          ? `EquiRoute produced no result. ${cause.describe()}`
          : "EquiRoute produced no result.",
        options.clock,
      );
      return { report, explanation: renderSentinelReport(report) };
    }

    // 3, 5, 6, 7, 8 — deterministic structured report.
    const report = buildSentinelReport({
      intent,
      route,
      policy,
      routeError,
        policyError,
        quoteContextAddress,
        ...(options.clock ? { clock: options.clock } : {}),
    });

    // 9 — explanation. Numbers come from the report, in code.
    const explained = await explainSentinelReport(report, {
      model,
      sessionId: opts.sessionId ?? "sentinel",
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    });

    // 10 — deliverable.
    return {
      report,
      explanation: explained.text,
      commentaryStatus: explained.commentaryStatus,
    };
  }

  async function evaluateWatch(
    request: unknown,
    opts: { sessionId?: string; abortSignal?: AbortSignal } = {},
  ): Promise<{
    watch: MarketWatch;
    evaluation: WatchEvaluation;
    explanation: string;
    commentaryStatus?: string;
  }> {
    const watch = validateMarketWatch(request);
    const analysis = await analyze(watch, opts);
    const evaluation = evaluateWatchReport(watch, analysis.report);
    return {
      watch,
      evaluation,
      explanation: `${analysis.explanation}\n\nMarket Watch matched: ${evaluation.matched}.`,
      ...(analysis.commentaryStatus !== undefined
        ? { commentaryStatus: analysis.commentaryStatus }
        : {}),
    };
  }

  return {
    analyze,
    evaluateWatch,
    async analyzeToText(request, opts) {
      return renderDeliverableText(await analyze(request, opts));
    },
  };
}

function readString(source: unknown, field: string): string | null {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

/**
 * Classify a failed pass. A non-EquiRouteError is wrapped so a transport bug
 * still degrades into a safe report instead of crashing a face.
 */
function asEquiRouteError(reason: unknown): EquiRouteError {
  if (reason instanceof EquiRouteError) return reason;
  return new EquiRouteError(
    "unreachable",
    "<unknown>",
    reason instanceof Error ? reason.message : String(reason),
  );
}
