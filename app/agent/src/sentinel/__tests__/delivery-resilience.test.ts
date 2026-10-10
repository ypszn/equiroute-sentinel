/**
 * ERC-8183 delivery resilience: an OPTIONAL model failure must never lose a
 * funded delivery.
 *
 * Reproduces the deployed failure shape (provider 429 → AI_RetryError) and
 * proves the background job still completes using only the deterministic
 * EquiRoute-backed Sentinel report, with no second model call.
 *
 * No transaction is constructed or broadcast: `signing` is a stub and job
 * 1421 is never submitted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SellerCore, type SellerCoreOpts, type SigningApi } from "../../sellerCore.js";
import { buildSentinelWorkHook, modelUnavailableDeliverable } from "../delivery.js";
import { createSentinelRunner } from "../runner.js";
import { REPORT_DELIMITER } from "../runner.js";
import type { SentinelReport } from "../types.js";
import {
  BSTOCK_SHARES,
  BSTOCK_USD_PER_SHARE,
  policyFixture,
  routeFixture,
} from "./fixtures.js";
import { fakeClient, fixedClock, forbiddenSigning } from "./helpers.js";

/** The provider error shape observed in the deployed logs. */
function rateLimitError(): Error {
  const error = new Error("Failed after 3 attempts. Last error: Too Many Requests");
  error.name = "AI_RetryError";
  return error;
}

type CommentaryModel = NonNullable<Parameters<typeof createSentinelRunner>[0]>["model"];

function runner(model: CommentaryModel) {
  return createSentinelRunner({
    client: fakeClient({ route: routeFixture(), policy: policyFixture() }),
    model,
    clock: fixedClock,
  });
}

function silentLog() {
  const warnings: string[] = [];
  return {
    warnings,
    log: { warn: (m: string) => warnings.push(m), info: () => {} },
  };
}

/** A signing stub that records the submitted deliverable instead of chain I/O. */
function recordingSigning(): {
  api: SigningApi;
  submitted: Array<{ jobId: number; content: string }>;
  verifyCalls: number;
} {
  const submitted: Array<{ jobId: number; content: string }> = [];
  const state = { verifyCalls: 0 };
  const api = {
    ...(forbiddenSigning().api as unknown as SigningApi),
    verifySignedJob: async () => {
      state.verifyCalls += 1;
      return { ok: true, reason: "stub-verified", permanent: false };
    },
    jobSpec: async (jobId: number) => ({
      task: `Analyze ticker NVDA for a notional of $10 with 0.5% slippage (job ${jobId})`,
      terms: {
        deliverables: "Structured Sentinel report",
        quality_standards: "Deterministic, auditable",
      },
    }),
    submitResult: async (
      jobId: number,
      content: string,
    ): Promise<{ submitTx: string; deliverableUrl: string | null }> => {
      submitted.push({ jobId, content });
      return { submitTx: "0xstub", deliverableUrl: "file://stub" };
    },
  } as unknown as SigningApi;
  return {
    api,
    submitted,
    get verifyCalls() {
      return state.verifyCalls;
    },
  };
}

function core(
  signing: SigningApi,
  model: CommentaryModel,
  log: SellerCoreOpts extends never ? never : ReturnType<typeof silentLog>["log"],
  llm?: () => Promise<string>,
): SellerCore {
  const sentinel = runner(model);
  const opts: SellerCoreOpts = {
    runWork: buildSentinelWorkHook({
      sentinel,
      llm: llm ?? (async () => "generic llm output"),
      log,
    }),
    generator: "equiroutesentinel-test",
    network: "bsc-testnet",
    commerceSkills: true,
    sentinel,
    signing,
    pendingJobs: async () => ({ jobs: [] }),
  };
  return new SellerCore(opts);
}

function parseSubmitted(content: string): SentinelReport {
  const index = content.indexOf(REPORT_DELIMITER);
  assert.ok(index > 0, "submitted deliverable must embed the structured report");
  return JSON.parse(content.slice(index + REPORT_DELIMITER.length)) as SentinelReport;
}

test("normal model commentary path delivers the report plus guarded commentary", async () => {
  const signing = recordingSigning();
  const { log } = silentLog();
  const agent = core(
    signing.api,
    async () => "Only one wrapper had a verified ratio, so the others were set aside.",
    log,
  );

  const ack = await agent.notifyFunded({ job_id: 1001 });
  assert.equal(ack.status, "accepted");
  await agent.drain();

  assert.equal(signing.submitted.length, 1);
  const submission = signing.submitted[0];
  assert.equal(submission?.jobId, 1001);
  assert.match(String(submission?.content), /Analyst note/);
  const report = parseSubmitted(String(submission?.content));
  assert.equal(report.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(report.execution.authorization, "none");
});

test("a 429 from the model does not fail delivery and submits the deterministic report", async () => {
  const signing = recordingSigning();
  const { log, warnings } = silentLog();
  // Every model call rejects exactly like the deployed provider did.
  const agent = core(
    signing.api,
    async () => {
      throw rateLimitError();
    },
    log,
    async () => {
      throw rateLimitError();
    },
  );

  const ack = await agent.notifyFunded({ job_id: 1421 });
  assert.equal(ack.status, "accepted");
  await agent.drain();

  // Delivery completed: submitResult ran despite the model failure.
  assert.equal(signing.submitted.length, 1, "funded job must still be delivered");
  const content = String(signing.submitted[0]?.content);

  // The deliverable is the deterministic Sentinel report, not a model answer.
  const report = parseSubmitted(content);
  assert.equal(report.selectedRepresentation?.provider, "bstock");
  assert.equal(report.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(report.market.regime, "premarket");
  assert.equal(report.policy.outcome, "confirmation_required");
  assert.equal(report.alternatives.length, 2);
  assert.equal(report.execution.authorization, "none");
  assert.equal(report.execution.requiresUserReviewInEquiRoute, true);

  // Commentary was omitted, and that omission is logged clearly.
  assert.equal(content.includes("Analyst note"), false);
  assert.ok(
    warnings.some((w) => w.includes("model commentary omitted")),
    `warnings were ${JSON.stringify(warnings)}`,
  );
});

test("fallback changes no numeric or policy value and needs no second model call", async () => {
  const signing = recordingSigning();
  const { log } = silentLog();
  let modelCalls = 0;
  const agent = core(
    signing.api,
    async () => {
      modelCalls += 1;
      throw rateLimitError();
    },
    log,
  );

  await agent.notifyFunded({ job_id: 1422 });
  await agent.drain();

  const report = parseSubmitted(String(signing.submitted[0]?.content));
  // Values are byte-identical to the EquiRoute fixture.
  assert.equal(report.selectedRepresentation?.normalizedUnderlyingShares, BSTOCK_SHARES);
  assert.equal(report.selectedRepresentation?.effectiveUsdPerShare, BSTOCK_USD_PER_SHARE);
  assert.deepEqual(report.policy.confirmationReasons, [
    "Market is premarket; mandate requires confirmation",
  ]);
  assert.deepEqual(report.policy.blockingReasons, []);
  // Exactly one commentary attempt; the fallback itself calls no model.
  assert.equal(modelCalls, 1, "the deterministic fallback must not retry the model");
});

test("a job naming no analysable request still yields a valid non-fabricated deliverable", async () => {
  const signing = recordingSigning();
  // Override the spec so the job text carries no ticker or notional.
  const api = {
    ...(signing.api as unknown as Record<string, unknown>),
    jobSpec: async () => ({
      task: "Produce the agreed deliverable.",
      terms: { deliverables: "A report", quality_standards: "Accurate" },
    }),
  } as unknown as SigningApi;
  const { log, warnings } = silentLog();
  const agent = core(
    api,
    async () => {
      throw rateLimitError();
    },
    log,
    async () => {
      throw rateLimitError();
    },
  );

  await agent.notifyFunded({ job_id: 1423 });
  await agent.drain();

  assert.equal(signing.submitted.length, 1);
  const payload = JSON.parse(String(signing.submitted[0]?.content)) as Record<
    string,
    unknown
  >;
  assert.equal(payload.status, "model_unavailable");
  assert.equal(payload.authorization, "none");
  assert.equal(payload.requiresUserReviewInEquiRoute, true);
  // No analysis is invented.
  assert.equal("selectedRepresentation" in payload, false);
  assert.equal("policy" in payload, false);
  assert.ok(warnings.some((w) => w.includes("model provider unavailable")));
});

test("the deterministic status deliverable never fabricates analysis", () => {
  const text = modelUnavailableDeliverable("JOB CONTEXT:\nanything", "429");
  const payload = JSON.parse(text) as Record<string, unknown>;
  assert.equal(payload.kind, "equiroute_sentinel_delivery");
  assert.equal(payload.authorization, "none");
  assert.equal(payload.requiresUserReviewInEquiRoute, true);
  assert.match(String(payload.note), /No .*analysis, quote, route or policy outcome/su);
});
