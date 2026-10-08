/**
 * Human-readable Sentinel explanation.
 *
 * ## The numeric contract
 *
 * Every number the reader sees is formatted HERE, in fixed code, straight from
 * the structured report's decimal strings. The LLM is never asked to compute,
 * restate or reformat a value.
 *
 * The LLM's only job is optional prose commentary, appended under a clearly
 * labelled heading. That commentary passes {@link guardCommentary} first:
 *
 *  - any numeric token it emits must already appear in the structured report,
 *    so it cannot invent, round or alter a quote, share count or price;
 *  - execution/authorization language is refused outright.
 *
 * Commentary that fails the guard is DISCARDED. The deterministic body is
 * always returned, so an absent, slow or misbehaving LLM can never change the
 * numbers or the verdict.
 */

import type { SentinelReport } from "./types.js";

/** Numeric-looking tokens, including decimals and separators. */
const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/gu;

/**
 * Phrases that would misrepresent the execution boundary. The Sentinel never
 * authorizes, prepares, signs or broadcasts anything.
 */
const FORBIDDEN_COMMENTARY = [
  /\bi (?:have )?(?:executed|submitted|placed|signed|broadcast)\b/iu,
  /\b(?:transaction|trade|order|swap) (?:was |has been )?(?:executed|submitted|placed|signed|broadcast|sent)\b/iu,
  /\bauthoriz(?:e|ed|ing) (?:the )?(?:execution|trade|transaction|swap)\b/iu,
  /\bexecuting (?:the )?(?:trade|transaction|swap|order)\b/iu,
  /\bi will (?:execute|buy|sell|trade|sign|submit)\b/iu,
  /\bon your behalf i (?:bought|sold|traded)\b/iu,
];

/**
 * Markers of leaked chain-of-thought or prompt meta-discussion. Small/free
 * models frequently emit their scratchpad; that is not commentary a reader
 * should see, so it is refused rather than published.
 */
const META_LEAKAGE = [
  /<\/?think(?:ing)?>/iu,
  /\bthe user (?:wants|asked|is asking)\b/iu,
  /\bI need to (?:follow|explain|write|answer)\b/iu,
  /\bhard rules?\b/iu,
  /\bbased only on the json\b/iu,
  /\bfrom the json\b/iu,
  /\bper the instructions?\b/iu,
  /\bas (?:an? )?(?:ai|language model)\b/iu,
];

/** Commentary longer than a few sentences is scratchpad, not commentary. */
const MAX_COMMENTARY_CHARS = 700;

/**
 * Keep only the model's final answer: drop any reasoning block and the text
 * that precedes its close tag.
 */
export function stripReasoning(raw: string): string {
  let text = raw;
  // Paired blocks first.
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/giu, " ");
  // An unpaired close tag means everything before it was the scratchpad.
  const lastClose = text.search(/<\/think(?:ing)?>/iu);
  if (lastClose !== -1) {
    const after = text.slice(lastClose).replace(/^<\/think(?:ing)?>/iu, "");
    text = after;
  }
  // An unpaired open tag means everything after it was the scratchpad.
  text = text.replace(/<think(?:ing)?>[\s\S]*$/giu, " ");
  return text.trim();
}

const STATUS_HEADLINE: Record<SentinelReport["opportunity"]["status"], string> = {
  actionable: "Actionable",
  needs_confirmation: "Needs confirmation",
  blocked: "Blocked",
  unavailable: "Unavailable",
};

const REGIME_LABEL: Record<string, string> = {
  regular: "Regular session",
  premarket: "Premarket",
  postmarket: "Postmarket",
  offhours: "Offhours",
  closed: "Closed",
  paused: "Paused",
  restricted: "Restricted",
  unknown: "Unknown",
};

function regimeLabel(regime: string | null): string {
  if (regime === null) return "Unavailable";
  return REGIME_LABEL[regime] ?? regime;
}

/** Collect every numeric token the report legitimately contains. */
export function reportNumbers(report: SentinelReport): Set<string> {
  const allowed = new Set<string>();
  for (const match of JSON.stringify(report).matchAll(NUMBER_TOKEN)) {
    allowed.add(match[0]);
  }
  // The deterministic body also prints the ticker/notional in prose form.
  for (const match of renderSentinelReport(report).matchAll(NUMBER_TOKEN)) {
    allowed.add(match[0]);
  }
  return allowed;
}

export type CommentaryVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Accept LLM commentary only if it alters no number, claims no execution, and
 * leaks no reasoning scratchpad.
 */
export function guardCommentary(
  commentary: string,
  report: SentinelReport,
): CommentaryVerdict {
  const text = stripReasoning(commentary);
  if (text === "") return { ok: false, reason: "empty commentary" };
  if (text.length > MAX_COMMENTARY_CHARS) {
    return { ok: false, reason: "commentary too long" };
  }

  for (const pattern of META_LEAKAGE) {
    if (pattern.test(text)) {
      return { ok: false, reason: "commentary leaked prompt or reasoning text" };
    }
  }

  for (const pattern of FORBIDDEN_COMMENTARY) {
    if (pattern.test(text)) {
      return { ok: false, reason: "commentary implied an execution or authorization" };
    }
  }

  const allowed = reportNumbers(report);
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    if (!allowed.has(match[0])) {
      return {
        ok: false,
        reason: `commentary introduced a number not present in the report: ${match[0]}`,
      };
    }
  }
  return { ok: true, text };
}

/**
 * Deterministic human-readable report. Pure function of the structured report;
 * identical input always renders identical output.
 */
export function renderSentinelReport(report: SentinelReport): string {
  const lines: string[] = [];
  const { intent, market, selectedRepresentation, policy, opportunity } = report;

  lines.push(`${intent.ticker} Market Sentinel`);
  lines.push("");

  lines.push("Best compliant representation:");
  if (selectedRepresentation === null) {
    lines.push("None — EquiRoute selected no compliant representation.");
  } else {
    lines.push(
      `${selectedRepresentation.provider} / ${selectedRepresentation.symbol}`,
    );
    lines.push(`Contract: ${selectedRepresentation.contractAddress}`);
    if (selectedRepresentation.executionMode !== null) {
      lines.push(`Execution mode: ${selectedRepresentation.executionMode}`);
    }
  }
  lines.push("");

  lines.push("Market:");
  lines.push(regimeLabel(market.regime));
  lines.push("");

  lines.push(`For $${intent.notionalUsd} (slippage ${intent.slippagePercent}%):`);
  if (selectedRepresentation === null) {
    lines.push("Expected exposure: unavailable");
    lines.push("Effective USD/share: unavailable");
  } else {
    lines.push(
      `Expected exposure: ${
        selectedRepresentation.normalizedUnderlyingShares ?? "unavailable"
      } ${intent.ticker} shares`,
    );
    lines.push(
      `Expected token output: ${
        selectedRepresentation.expectedOutput ?? "unavailable"
      } ${selectedRepresentation.symbol}`,
    );
    lines.push(
      `Effective USD/share: ${
        selectedRepresentation.effectiveUsdPerShare ?? "unavailable"
      }`,
    );
  }
  lines.push("");

  lines.push("Policy:");
  lines.push(`Outcome: ${policy.outcome}`);
  if (policy.blockingReasons.length > 0) {
    lines.push("Blocking:");
    for (const reason of policy.blockingReasons) lines.push(`- ${reason}`);
  }
  if (policy.confirmationReasons.length > 0) {
    lines.push("Confirmation required:");
    for (const reason of policy.confirmationReasons) lines.push(`- ${reason}`);
  }
  if (policy.blockingReasons.length === 0 && policy.confirmationReasons.length === 0) {
    lines.push(
      policy.outcome === "unavailable"
        ? "- No deterministic policy decision was returned."
        : "- No blocking or confirmation reasons were raised.",
    );
  }
  lines.push("");

  lines.push("Alternatives:");
  lines.push(`Comparison: ${report.comparison.status}`);
  if (report.comparison.status === "degraded") {
    lines.push(
      `Evaluated representations: ${report.comparison.evaluatedRepresentations} of ${report.comparison.totalRepresentations}`,
    );
    lines.push(
      `Economically comparable: ${report.comparison.economicallyComparableRepresentations}`,
    );
    lines.push(
      `Unavailable representations: ${report.comparison.unavailableRepresentations}`,
    );
    for (const unavailable of report.comparison.unavailableBy) {
      lines.push(`Unavailable: ${unavailable}`);
    }
    for (const degraded of report.comparison.degradedBy) {
      lines.push(`Not compared: ${degraded}`);
    }
  }
  if (report.alternatives.length === 0) {
    lines.push("None evaluated.");
  } else {
    for (const alternative of report.alternatives) {
      const head = `${alternative.provider} / ${alternative.symbol}`;
      if (alternative.eligible) {
        lines.push(
          `${head} — eligible; ${
            alternative.normalizedUnderlyingShares ?? "unavailable"
          } shares at ${alternative.effectiveUsdPerShare ?? "unavailable"} USD/share`,
        );
      } else {
        lines.push(
          `${head} — not eligible (${alternative.rejectionClass ?? "QUOTE_FAILED"}): ${alternative.rejectionReason ?? "no reason reported"}${
            alternative.rejectionCode ? ` [${alternative.rejectionCode}]` : ""
          }`,
        );
      }
    }
  }
  lines.push("");

  lines.push(`Opportunity: ${STATUS_HEADLINE[opportunity.status]}`);
  lines.push(opportunity.reason);
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push("Next action:");
  lines.push("Review this opportunity in EquiRoute.");
  lines.push("");
  lines.push("No transaction has been authorized or executed.");

  return lines.join("\n");
}

/**
 * Prompt for the optional commentary. The model is told explicitly that the
 * numbers are fixed and that it has no authority over the verdict.
 */
export function commentaryPrompt(report: SentinelReport): string {
  return [
    "You are commenting on a FINISHED, deterministic tokenized-equity analysis",
    "produced by the EquiRoute engine. The selection, the quotes, the market",
    "regime and the policy outcome are already decided and are NOT yours to",
    "change, rerank or recompute.",
    "",
    "Write at most three short sentences of plain-prose commentary that help a",
    "human understand WHY the representations differ and WHY the policy reached",
    "this outcome.",
    "",
    "HARD RULES:",
    "- Reply with the commentary sentences ONLY. No preamble, no reasoning, no",
    "  restating of these instructions, no bullet lists, no headings.",
    "- Do NOT write any digit or number. Describe relationships in words only.",
    "- Do NOT recommend, authorize, prepare or claim any trade or transaction.",
    "- Do NOT choose a different representation or dispute the policy outcome.",
    "- Do NOT use tools. Answer from the JSON below only.",
    "",
    "ANALYSIS (JSON):",
    JSON.stringify(report),
  ].join("\n");
}

/** The LLM seam used for commentary (same shape as the scaffold's RunWork). */
export type CommentaryModel = (
  prompt: string,
  opts: { sessionId: string; abortSignal?: AbortSignal },
) => Promise<string>;

export interface ExplainOptions {
  readonly model?: CommentaryModel | null;
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
}

/**
 * Deterministic body, plus guarded LLM commentary when a model is available.
 *
 * Never throws: an LLM failure degrades to the deterministic body alone.
 */
export async function explainSentinelReport(
  report: SentinelReport,
  options: ExplainOptions = {},
): Promise<{ text: string; commentary: string | null; commentaryStatus: string }> {
  const body = renderSentinelReport(report);
  const model = options.model ?? null;
  if (model === null) {
    return { text: body, commentary: null, commentaryStatus: "no_model" };
  }

  let raw: string;
  try {
    raw = await model(commentaryPrompt(report), {
      sessionId: options.sessionId ?? "sentinel",
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  } catch {
    return { text: body, commentary: null, commentaryStatus: "model_failed" };
  }

  const verdict = guardCommentary(raw, report);
  if (!verdict.ok) {
    return { text: body, commentary: null, commentaryStatus: `rejected: ${verdict.reason}` };
  }
  return {
    text: `${body}\n\nAnalyst note (model commentary; no numbers changed):\n${verdict.text}`,
    commentary: verdict.text,
    commentaryStatus: "accepted",
  };
}
