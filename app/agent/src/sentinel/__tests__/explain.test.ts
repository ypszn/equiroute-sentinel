/**
 * LLM boundaries: the model explains, it never computes.
 *
 * Covers required case 13 (numeric outputs are not recalculated by the LLM),
 * plus the determinism of the renderer and the refusal of commentary that
 * claims an execution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commentaryPrompt,
  explainSentinelReport,
  guardCommentary,
  renderSentinelReport,
  stripReasoning,
} from "../explain.js";
import { createSentinelRunner } from "../runner.js";
import type { SentinelReport } from "../types.js";
import {
  BSTOCK_SHARES,
  BSTOCK_USD_PER_SHARE,
  NVDA_INTENT,
  policyFixture,
  routeFixture,
} from "./fixtures.js";
import { fakeClient, fixedClock } from "./helpers.js";

async function reportFor(
  model: ((prompt: string) => Promise<string>) | null,
): Promise<{ report: SentinelReport; explanation: string }> {
  const sentinel = createSentinelRunner({
    client: fakeClient({ route: routeFixture(), policy: policyFixture() }),
    model: model === null ? null : async (prompt) => model(prompt),
    clock: fixedClock,
  });
  return sentinel.analyze({ ...NVDA_INTENT });
}

// ── 13. Numeric outputs are not recalculated by the LLM ─────────────────────

test("13. a model that alters a number has its commentary discarded", async () => {
  // The model restates the share count with a different value.
  const { report, explanation } = await reportFor(
    async () => "The expected exposure is really 0.0999999999 shares, much better.",
  );

  // The structured numbers are untouched...
  assert.equal(report.selectedRepresentation?.normalizedUnderlyingShares, BSTOCK_SHARES);
  assert.equal(report.selectedRepresentation?.effectiveUsdPerShare, BSTOCK_USD_PER_SHARE);
  // ...and the invented number never reaches the reader.
  assert.equal(explanation.includes("0.0999999999"), false);
  assert.equal(explanation.includes("Analyst note"), false);
  // The deterministic values are the ones presented.
  assert.ok(explanation.includes(BSTOCK_SHARES));
  assert.ok(explanation.includes(BSTOCK_USD_PER_SHARE));
});

test("13. the guard rejects any number absent from the report", () => {
  const report = baseReport();
  assert.equal(guardCommentary("Roughly 42 shares.", report).ok, false);
  assert.equal(guardCommentary("A 15% better price.", report).ok, false);
  // Rounding is an alteration too.
  assert.equal(guardCommentary(`About ${BSTOCK_SHARES} shares.`, report).ok, true);
  assert.equal(guardCommentary("About 0.04 shares.", report).ok, false);
});

test("13. number-free prose commentary is accepted and labelled", async () => {
  const { explanation } = await reportFor(
    async () =>
      "Only one wrapper had a verified ratio, so the others were set aside. " +
      "The session is outside regular hours, which is why confirmation is needed.",
  );
  assert.match(explanation, /Analyst note \(model commentary; no numbers changed\)/);
  assert.match(explanation, /verified ratio/);
  // The deterministic body is still present and first.
  assert.ok(explanation.indexOf("NVDA Market Sentinel") < explanation.indexOf("Analyst note"));
});

test("13. commentary claiming an execution is refused", () => {
  const report = baseReport();
  for (const claim of [
    "I have executed the trade for you.",
    "The transaction was submitted successfully.",
    "I will buy the shares now.",
    "Authorizing the execution on your behalf.",
    "Executing the swap now.",
  ]) {
    const verdict = guardCommentary(claim, report);
    assert.equal(verdict.ok, false, claim);
    if (!verdict.ok) assert.match(verdict.reason, /execution|authorization/);
  }
});

test("13. leaked chain-of-thought is stripped, and meta-talk is refused", () => {
  const report = baseReport();

  // A paired reasoning block is dropped and the real answer survives.
  const paired = guardCommentary(
    "<think>I should mention the ratio.</think>Only one wrapper had a verified ratio.",
    report,
  );
  assert.equal(paired.ok, true);
  if (paired.ok) assert.equal(paired.text, "Only one wrapper had a verified ratio.");

  // An unpaired close tag means everything before it was scratchpad.
  const unpaired = guardCommentary(
    "The user wants me to explain.\n</think>\nThe session is outside regular hours.",
    report,
  );
  assert.equal(unpaired.ok, true);
  if (unpaired.ok) assert.equal(unpaired.text, "The session is outside regular hours.");

  // Meta-discussion that is NOT inside a tag is refused outright.
  for (const leak of [
    "The user wants me to summarise the providers.",
    "I need to follow hard rules, so here goes.",
    "From the JSON, the selected provider supports swaps.",
    "As an AI language model, I observe that ratios differ.",
  ]) {
    const verdict = guardCommentary(leak, report);
    assert.equal(verdict.ok, false, leak);
    if (!verdict.ok) assert.match(verdict.reason, /leaked prompt or reasoning/);
  }
});

test("13. scratchpad-length commentary is refused", () => {
  const verdict = guardCommentary("word ".repeat(300), baseReport());
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /too long/);
});

test("13. stripReasoning keeps plain text untouched", () => {
  assert.equal(stripReasoning("  plain commentary.  "), "plain commentary.");
  assert.equal(stripReasoning("<thinking>x</thinking> answer"), "answer");
  assert.equal(stripReasoning("answer <think>trailing scratchpad"), "answer");
});

test("13. a failing or absent model never changes the deliverable numbers", async () => {
  const deterministic = await reportFor(null);
  const failing = await reportFor(async () => {
    throw new Error("provider down");
  });
  const empty = await reportFor(async () => "   ");

  assert.equal(failing.explanation, deterministic.explanation);
  assert.equal(empty.explanation, deterministic.explanation);
  assert.deepEqual(failing.report, deterministic.report);
});

test("13. the commentary prompt forbids digits, reranking and authorization", () => {
  const prompt = commentaryPrompt(baseReport());
  assert.match(prompt, /Do NOT write any digit or number/);
  assert.match(prompt, /Do NOT recommend, authorize, prepare or claim any trade/);
  assert.match(prompt, /Do NOT choose a different representation/);
  assert.match(prompt, /Do NOT use tools/);
});

// ── Determinism of the renderer ─────────────────────────────────────────────

test("the renderer is a pure function of the report", () => {
  const report = baseReport();
  assert.equal(renderSentinelReport(report), renderSentinelReport(structuredClone(report)));
});

test("the renderer prints EquiRoute's strings, not reformatted numbers", () => {
  const text = renderSentinelReport(baseReport());
  assert.ok(text.includes(BSTOCK_SHARES));
  assert.ok(text.includes(BSTOCK_USD_PER_SHARE));
  assert.match(text, /Market:\nPremarket/);
  assert.match(text, /Next action:\nReview this opportunity in EquiRoute\./);
  assert.match(text, /No transaction has been authorized or executed\./);
});

test("the explanation never claims an execution happened", async () => {
  const { explanation } = await reportFor(null);
  for (const forbidden of [
    /\bexecuted\b/i,
    /\bbroadcast\b/i,
    /\bsigned\b/i,
    /\bsubmitted\b/i,
  ]) {
    // The only permitted appearance is the explicit negative statement.
    const offending = explanation
      .split("\n")
      .filter((line) => forbidden.test(line))
      .filter((line) => !line.includes("No transaction has been authorized or executed"));
    assert.deepEqual(offending, [], String(forbidden));
  }
});

function baseReport(): SentinelReport {
  return {
    version: "1",
    generatedAt: "2026-10-08T12:00:00.000Z",
    intent: { ticker: "NVDA", notionalUsd: "10", slippagePercent: "0.5" },
    market: { regime: "premarket", available: true },
    selectedRepresentation: {
      provider: "bstock",
      symbol: "NVDAB",
      contractAddress: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
      executionMode: "SWAP",
      expectedOutput: "0.042498353480453487",
      normalizedUnderlyingShares: BSTOCK_SHARES,
      effectiveUsdPerShare: BSTOCK_USD_PER_SHARE,
    },
    alternatives: [
      {
        provider: "ondo",
        symbol: "NVDAon",
        eligible: false,
        rejectionReason: "userWalletAddress is required for RFQ (Ondo) quote",
        rejectionCode: "40001",
        normalizedUnderlyingShares: null,
        effectiveUsdPerShare: null,
      },
     ],
    quoteContext: {
      addressUsed: null,
      purpose: "read_only_quote_context",
      executionAuthority: false,
    },
    comparison: {
      status: "degraded",
      totalRepresentations: 3,
      evaluatedRepresentations: 3,
      economicallyComparableRepresentations: 2,
      unavailableRepresentations: 1,
      unavailableBy: ["ondo/NVDAon: QUOTE_CONTEXT_ADDRESS_REQUIRED"],
      degradedBy: ["ondo/NVDAon: QUOTE_CONTEXT_ADDRESS_REQUIRED"],
    },
    policy: {
      outcome: "confirmation_required",
      blockingReasons: [],
      confirmationReasons: ["Market is premarket; mandate requires confirmation"],
    },
    opportunity: {
      status: "needs_confirmation",
      reason:
        "EquiRoute policy requires human confirmation: Market is premarket; mandate requires confirmation",
    },
    execution: { authorization: "none", requiresUserReviewInEquiRoute: true },
    warnings: [],
  };
}
