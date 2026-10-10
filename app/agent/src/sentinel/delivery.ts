/**
 * ERC-8183 / text-carrier delivery hook.
 *
 * Delivery must never be lost to an OPTIONAL model call. EquiRoute's
 * deterministic routing and policy stay authoritative; LLM commentary is
 * supplemental. This module composes the routing so that every model failure
 * mode — 429 rate limit, provider outage, timeout, model error — degrades to
 * the deterministic Sentinel report and still yields a complete deliverable
 * for on-chain submission.
 *
 * Fallback rules (all fixed code, no second model call):
 *
 *  1. Structured Sentinel / MarketWatch request → deterministic path. The
 *     commentary layer already discards a failed model internally, so the
 *     report and explanation are produced from EquiRoute data alone.
 *  2. Prose job text that explicitly names a ticker AND notional →
 *     deterministic Sentinel analysis recovered by fixed-code extraction.
 *  3. Anything else → the generic LLM hook. If that model call fails, we
 *     return a deterministic status deliverable instead of throwing, so the
 *     funded job is still submitted. No analysis is fabricated.
 *
 * Nothing here signs, prepares, executes or authorizes anything.
 */

import {
  sentinelIntentFromJobText,
  sentinelIntentFromPrompt,
  watchFromPrompt,
} from "./request.js";
import { renderDeliverableText, type SentinelRunner } from "./runner.js";

/** The generic LLM work hook shape (matches the scaffold's `RunWork`). */
export type LlmWorkHook = (
  prompt: string,
  opts: { sessionId: string; abortSignal?: AbortSignal },
) => Promise<string>;

export interface SentinelWorkHookOptions {
  readonly llm: LlmWorkHook;
  readonly sentinel: SentinelRunner;
  /** Injectable logger seam (defaults to console). */
  readonly log?: {
    warn: (message: string) => void;
    info: (message: string) => void;
  };
}

const defaultLog = {
  warn: (message: string) => console.warn(`[sentinel.delivery] ${message}`),
  info: (message: string) => console.log(`[sentinel.delivery] ${message}`),
};

/** Statuses that mean the OPTIONAL model, not EquiRoute, was unavailable. */
function isModelUnavailable(status: string | undefined): boolean {
  return status === "model_failed" || status === "no_model";
}

/**
 * Deterministic deliverable for a job that named no analysable request AND
 * whose optional model call failed.
 *
 * Deliberately carries NO representation, quote, regime or policy outcome:
 * inventing them would fabricate analysis. It still states the execution
 * boundary so the deliverable is unambiguous on-chain.
 */
export function modelUnavailableDeliverable(
  prompt: string,
  reason: string,
): string {
  return JSON.stringify(
    {
      kind: "equiroute_sentinel_delivery",
      status: "model_unavailable",
      authorization: "none",
      requiresUserReviewInEquiRoute: true,
      reason,
      note:
        "The optional language-model commentary provider was unavailable and " +
        "this job named no structured Sentinel request (ticker + notional), " +
        "so no deterministic EquiRoute analysis could be produced. No " +
        "analysis, quote, route or policy outcome has been inferred, and no " +
        "transaction has been authorized or executed.",
      jobContext: prompt.slice(0, 2000),
    },
    null,
    2,
  );
}

/**
 * Compose the Sentinel value layer in front of the generic LLM hook.
 *
 * Returned hook never throws for an optional-model failure, so ERC-8183
 * background delivery always reaches `submitResult`.
 */
export function buildSentinelWorkHook(
  options: SentinelWorkHookOptions,
): LlmWorkHook {
  const { llm, sentinel } = options;
  const log = options.log ?? defaultLog;

  return async (prompt, opts) => {
    const forward = {
      sessionId: opts.sessionId,
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    };

    // 1 — structured MarketWatch request.
    const watch = watchFromPrompt(prompt);
    if (watch !== null) {
      const evaluated = await sentinel.evaluateWatch(watch, forward);
      if (isModelUnavailable(evaluated.commentaryStatus)) {
        log.warn(
          `job ${opts.sessionId}: model commentary omitted (${evaluated.commentaryStatus}); ` +
            "delivering the deterministic MarketWatch evaluation",
        );
      }
      return JSON.stringify({
        kind: "equiroute_market_watch",
        watch: evaluated.watch,
        evaluation: evaluated.evaluation,
        authorization: "none",
        explanation: evaluated.explanation,
      });
    }

    // 2 — structured Sentinel request, then deterministic prose recovery.
    const request =
      sentinelIntentFromPrompt(prompt) ?? sentinelIntentFromJobText(prompt);
    if (request !== null) {
      const deliverable = await sentinel.analyze(request, forward);
      if (isModelUnavailable(deliverable.commentaryStatus)) {
        log.warn(
          `job ${opts.sessionId}: model commentary omitted (${deliverable.commentaryStatus}); ` +
            "delivering the deterministic Sentinel report",
        );
      }
      return renderDeliverableText(deliverable);
    }

    // 3 — generic work. A model failure must not lose a funded delivery.
    try {
      return await llm(prompt, opts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(
        `job ${opts.sessionId}: model provider unavailable (${reason}); ` +
          "delivering a deterministic status deliverable without fabricating analysis",
      );
      return modelUnavailableDeliverable(prompt, reason);
    }
  };
}
