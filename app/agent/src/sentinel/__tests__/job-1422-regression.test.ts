/**
 * Regression: ERC-8183 job 1422 must route to deterministic Sentinel analysis.
 *
 * Job 1422 reached SUBMITTED but delivered a fabricated generic-LLM answer
 * (chain ambiguity, $10/unit assumptions, options/ETF "alternatives", fake
 * execution fields, leaked `thinking` text). This file pins the exact on-chain
 * task/terms text and proves the generic model can no longer produce financial
 * analysis for an EquiRoute Sentinel job.
 *
 * No transaction is constructed or broadcast; `signing` is a stub and job 1422
 * is never submitted or settled.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SellerCore, type SellerCoreOpts, type SigningApi } from "../../sellerCore.js";
import {
  buildSentinelWorkHook,
  sanitizeDeliverableText,
  sentinelUnavailableDeliverable,
} from "../delivery.js";
import {
  isSentinelJobText,
  sentinelIntentFromJobText,
  sentinelJobRequestFromPrompt,
} from "../request.js";
import { createSentinelRunner, REPORT_DELIMITER } from "../runner.js";
import type { SentinelReport } from "../types.js";
import {
  BSTOCK_ADDRESS,
  BSTOCK_OUTPUT,
  BSTOCK_SHARES,
  BSTOCK_USD_PER_SHARE,
  ONDO_FAILURE_REASON,
  policyFixture,
  routeFixture,
} from "./fixtures.js";
import { fakeClient, fixedClock, forbiddenSigning } from "./helpers.js";

// ── the exact deployed job 1422 ──────────────────────────────────────────────

const JOB_1422_TASK =
  "Analyze a $10 NVDA tokenized-equity opportunity and return an EquiRoute Sentinel assessment";

const JOB_1422_TERMS = {
  deliverables:
    "A structured EquiRoute Sentinel report with selected representation, " +
    "alternatives, market regime, policy outcome, and execution authorization state",
  quality_standards:
    "Use live EquiRoute data, preserve deterministic policy results, authorize no " +
    "transaction, and require user review in EquiRoute",
};

/** Byte-identical to the prompt sellerCore.doWorkAndSubmit builds. */
function job1422Prompt(): string {
  return (
    "You accepted and were paid for the following job. Produce the " +
    "deliverable now. Be complete and self-contained.\n\n" +
    `JOB CONTEXT:\n${JSON.stringify({ task: JOB_1422_TASK, terms: JOB_1422_TERMS })}`
  );
}

type CommentaryModel = NonNullable<Parameters<typeof createSentinelRunner>[0]>["model"];

function runner(model: CommentaryModel) {
  return createSentinelRunner({
    client: fakeClient({ route: routeFixture(), policy: policyFixture() }),
    model,
    clock: fixedClock,
  });
}

function captureLog() {
  const warnings: string[] = [];
  return { warnings, log: { warn: (m: string) => warnings.push(m), info: () => {} } };
}

function stubSigning(
  task: string,
  terms: Record<string, string>,
): { api: SigningApi; submitted: string[] } {
  const submitted: string[] = [];
  const api = {
    ...(forbiddenSigning().api as unknown as SigningApi),
    verifySignedJob: async () => ({ ok: true, reason: "stub", permanent: false }),
    jobSpec: async () => ({ task, terms }),
    submitResult: async (_jobId: number, content: string) => {
      submitted.push(content);
      return { submitTx: "0xstub", deliverableUrl: "file://stub" };
    },
  } as unknown as SigningApi;
  return { api, submitted };
}

function parseReport(content: string): SentinelReport {
  const index = content.indexOf(REPORT_DELIMITER);
  assert.ok(index > 0, "deliverable must embed the structured Sentinel report");
  return JSON.parse(content.slice(index + REPORT_DELIMITER.length)) as SentinelReport;
}

// ── A. the exact job text resolves to NVDA / $10 ────────────────────────────

test("A. job 1422 task text resolves deterministically to NVDA / $10", () => {
  assert.equal(isSentinelJobText(JOB_1422_TASK), true);
  assert.deepEqual(sentinelIntentFromJobText(JOB_1422_TASK), {
    ticker: "NVDA",
    notionalUsd: "10",
  });

  const recognised = sentinelJobRequestFromPrompt(job1422Prompt());
  assert.equal(recognised.sentinelJob, true);
  assert.deepEqual(recognised.intent, { ticker: "NVDA", notionalUsd: "10" });
});

test("A. the documented explicit notional/ticker forms all resolve", () => {
  const cases: Array<[string, string]> = [
    ["Analyze a $10 NVDA tokenized-equity opportunity", "10"],
    ["NVDA $10 Sentinel assessment", "10"],
    ["Sentinel report for $10 of NVDA", "10"],
    ["10 USD NVDA EquiRoute Sentinel report", "10"],
    ["NVDA with a $10 notional, EquiRoute Sentinel", "10"],
    ["ticker: NVDA, notionalUsd: 10 (EquiRoute Sentinel)", "10"],
  ];
  for (const [text, notional] of cases) {
    const intent = sentinelIntentFromJobText(text);
    assert.equal(intent?.ticker, "NVDA", text);
    assert.equal(intent?.notionalUsd, notional, text);
  }
});

test("A. nothing is inferred when ticker or notional is absent", () => {
  assert.equal(sentinelIntentFromJobText("Return an EquiRoute Sentinel report"), null);
  assert.equal(sentinelIntentFromJobText("Analyze a $10 opportunity"), null);
  assert.equal(sentinelIntentFromJobText("Analyze NVDA tokenized equity"), null);
});

// ── B/C/D/E/H. job 1422 end-to-end through the delivery path ────────────────

test("B+C+D+E+H. job 1422 delivers the real deterministic Sentinel report", async () => {
  const signing = stubSigning(JOB_1422_TASK, JOB_1422_TERMS);
  const { log } = captureLog();
  let genericLlmCalls = 0;
  let sentinelAnalyzeCalls = 0;

  const base = runner(async () => "Only one wrapper had a verified ratio.");
  const sentinel = {
    ...base,
    analyze: async (...args: Parameters<typeof base.analyze>) => {
      sentinelAnalyzeCalls += 1;
      return base.analyze(...args);
    },
  };

  const opts: SellerCoreOpts = {
    runWork: buildSentinelWorkHook({
      sentinel,
      llm: async () => {
        genericLlmCalls += 1;
        return "FABRICATED: Ethereum/BSC/Polygon, $10/unit, options and ETF alternatives.";
      },
      log,
    }),
    generator: "equiroutesentinel-test",
    network: "bsc-testnet",
    commerceSkills: true,
    sentinel,
    signing: signing.api,
    pendingJobs: async () => ({ jobs: [] }),
  };
  const agent = new SellerCore(opts);

  await agent.notifyFunded({ job_id: 1422 });
  await agent.drain();

  assert.equal(signing.submitted.length, 1);
  const content = signing.submitted[0] ?? "";

  // B — the generic LLM was never asked to produce the deliverable.
  assert.equal(genericLlmCalls, 0, "generic LLM must not be called for a Sentinel job");
  // C — the real Sentinel runner produced it.
  assert.equal(sentinelAnalyzeCalls, 1);

  // D — EquiRoute values are preserved byte-for-byte.
  const report = parseReport(content);
  assert.equal(report.selectedRepresentation?.provider, "bstock");
  assert.equal(report.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(report.selectedRepresentation?.contractAddress, BSTOCK_ADDRESS);
  assert.equal(report.selectedRepresentation?.normalizedUnderlyingShares, BSTOCK_SHARES);
  assert.equal(report.selectedRepresentation?.effectiveUsdPerShare, BSTOCK_USD_PER_SHARE);
  assert.equal(report.selectedRepresentation?.expectedOutput, BSTOCK_OUTPUT);
  assert.equal(report.market.regime, "premarket");
  assert.equal(report.policy.outcome, "confirmation_required");
  assert.equal(report.alternatives.length, 2);
  assert.equal(
    report.alternatives.find((a) => a.provider === "ondo")?.rejectionReason,
    ONDO_FAILURE_REASON,
  );
  assert.deepEqual(report.intent, {
    ticker: "NVDA",
    notionalUsd: "10",
    slippagePercent: "0.5",
  });

  // E — none of job 1422's fabricated artefacts can appear.
  for (const fabricated of [
    "Ethereum",
    "Polygon",
    "per unit",
    "$10/unit",
    "ETF",
    "option",
    "rawTransaction",
    "signedTransaction",
    "txHash",
  ]) {
    assert.equal(
      content.toLowerCase().includes(fabricated.toLowerCase()),
      false,
      `deliverable must not contain fabricated ${fabricated}`,
    );
  }

  // H — the execution boundary is intact.
  assert.equal(report.execution.authorization, "none");
  assert.equal(report.execution.requiresUserReviewInEquiRoute, true);
  assert.match(content, /No transaction has been authorized or executed\./);
});

// ── F. Sentinel-labelled but unextractable → deterministic, no LLM ──────────

test("F. a Sentinel job without ticker/notional returns unavailable and never calls the LLM", async () => {
  const task = "Return an EquiRoute Sentinel assessment for our portfolio";
  const signing = stubSigning(task, {
    deliverables: "A structured EquiRoute Sentinel report",
    quality_standards: "Authorize no transaction",
  });
  const { log, warnings } = captureLog();
  let genericLlmCalls = 0;
  const sentinel = runner(null);

  const agent = new SellerCore({
    runWork: buildSentinelWorkHook({
      sentinel,
      llm: async () => {
        genericLlmCalls += 1;
        return "FABRICATED generic analysis";
      },
      log,
    }),
    generator: "equiroutesentinel-test",
    commerceSkills: true,
    sentinel,
    signing: signing.api,
    pendingJobs: async () => ({ jobs: [] }),
  });

  await agent.notifyFunded({ job_id: 1424 });
  await agent.drain();

  assert.equal(genericLlmCalls, 0, "a Sentinel-labelled job must never reach the LLM");
  const payload = JSON.parse(signing.submitted[0] ?? "{}") as Record<string, unknown>;
  assert.equal(payload.kind, "equiroute_sentinel_delivery");
  assert.equal(payload.status, "unavailable");
  assert.equal(payload.authorization, "none");
  assert.equal(payload.requiresUserReviewInEquiRoute, true);
  assert.equal("selectedRepresentation" in payload, false);
  assert.equal("policy" in payload, false);
  assert.ok(warnings.some((w) => w.includes("generic LLM is disabled")));
});

test("F. the deterministic unavailable deliverable states the boundary", () => {
  const payload = JSON.parse(
    sentinelUnavailableDeliverable("JOB CONTEXT:\nx", "no ticker"),
  ) as Record<string, unknown>;
  assert.equal(payload.authorization, "none");
  assert.equal(payload.requiresUserReviewInEquiRoute, true);
  assert.match(String(payload.note), /No generic model analysis was used/);
});

// ── G. reasoning text can never reach the carrier ───────────────────────────

test("G. reasoning tags are stripped before any deliverable is uploaded", () => {
  const cases = [
    "<think>scratchpad</think>Answer body.",
    "<thinking>scratchpad</thinking>Answer body.",
    "leading scratchpad</think>Answer body.",
    "Answer body.<think>trailing scratchpad",
  ];
  for (const raw of cases) {
    const clean = sanitizeDeliverableText(raw);
    assert.equal(/<\/?think(?:ing)?>/iu.test(clean), false, raw);
    assert.equal(clean.includes("scratchpad"), false, raw);
    assert.match(clean, /Answer body\./, raw);
  }
});

test("G. a model answer carrying reasoning tags is sanitized at the submit boundary", async () => {
  // A non-Sentinel job still reaches the LLM; its output must be sanitized.
  const signing = stubSigning("Write a short haiku about BNB Chain.", {
    deliverables: "A haiku",
    quality_standards: "Three lines",
  });
  const { log } = captureLog();
  const sentinel = runner(null);
  const agent = new SellerCore({
    runWork: buildSentinelWorkHook({
      sentinel,
      llm: async () =>
        "<thinking>The user wants a haiku. I should write three lines.</thinking>Chain hums at midnight.",
      log,
    }),
    generator: "equiroutesentinel-test",
    commerceSkills: true,
    sentinel,
    signing: signing.api,
    pendingJobs: async () => ({ jobs: [] }),
  });

  await agent.notifyFunded({ job_id: 1425 });
  await agent.drain();

  const content = signing.submitted[0] ?? "";
  assert.equal(/<\/?think(?:ing)?>/iu.test(content), false);
  assert.equal(content.includes("The user wants a haiku"), false);
  assert.match(content, /Chain hums at midnight\./);
});
