/**
 * Public faces + the wallet/signing boundary.
 *
 * Covers required cases 18 (A2A returns the report), 19 (MCP tool returns the
 * report), 20 (x402 remains free), 21 (no wallet spend) and 22 (no Studio
 * signing exposed to the LLM).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { B402SellerPolicy } from "@bnbagent/studio-runtime/b402";
import { loadStudioToml } from "@bnbagent/studio-runtime/config";
import { buildAgentCard } from "../../agentCard.js";
import { SellerAgentExecutor } from "../../executor.js";
import { buildMcpServer } from "../../mcpMain.js";
import type { SellerCoreOpts, SigningApi } from "../../sellerCore.js";
import { LLM_READ_TOOLS } from "../../tools.js";
import { createSentinelRunner, renderDeliverableText, REPORT_DELIMITER } from "../runner.js";
import { SENTINEL_SKILL, sentinelIntentFromPrompt } from "../request.js";
import type { SentinelReport } from "../types.js";
import { BSTOCK_SHARES, NVDA_INTENT, policyFixture, routeFixture } from "./fixtures.js";
import { fakeClient, fixedClock, forbiddenSigning } from "./helpers.js";

function sentinelRunner() {
  return createSentinelRunner({
    client: fakeClient({ route: routeFixture(), policy: policyFixture() }),
    model: null,
    clock: fixedClock,
  });
}

/** Executor wired with a signing API that throws if it is ever touched. */
function executorWithTrap(): {
  executor: SellerAgentExecutor;
  signingTouched: string[];
  llmCalls: string[];
} {
  const trap = forbiddenSigning();
  const llmCalls: string[] = [];
  const opts: SellerCoreOpts = {
    runWork: async (prompt) => {
      llmCalls.push(prompt);
      return "the LLM must not be the analysis path";
    },
    generator: "equiroutesentinel",
    network: "bsc-testnet",
    commerceSkills: true,
    sentinel: sentinelRunner(),
    signing: trap.api as unknown as SigningApi,
    pendingJobs: async () => {
      throw new Error("the sweep must not run during analysis");
    },
  };
  return {
    executor: new SellerAgentExecutor(opts),
    signingTouched: trap.touched,
    llmCalls,
  };
}

// ── 18. A2A returns the report ──────────────────────────────────────────────

test("18. the A2A agent card advertises the Sentinel skill", () => {
  const card = buildAgentCard({ commerceSkills: true });
  const ids = card.skills.map((skill) => skill.id);
  assert.ok(ids.includes(SENTINEL_SKILL), `skills were ${ids.join(", ")}`);
  assert.deepEqual(ids, ["negotiate", "notify_funded", SENTINEL_SKILL, "evaluate_market_watch"]);

  const skill = card.skills.find((s) => s.id === SENTINEL_SKILL);
  assert.ok(skill !== undefined);
  assert.deepEqual(skill.inputModes, ["application/json"]);
  assert.deepEqual(skill.outputModes, ["application/json"]);
  // The card states the boundary a buyer must understand.
  assert.match(skill.description, /authorization: "none"/);
  assert.match(skill.description, /requiresUserReviewInEquiRoute: true/);
  assert.match(skill.description, /READ-ONLY/);

  // Still reachable with the commerce rail disabled: analysis is free.
  const free = buildAgentCard({ commerceSkills: false });
  assert.deepEqual(
    free.skills.map((s) => s.id),
    [SENTINEL_SKILL, "evaluate_market_watch"],
  );
});

test("18. the A2A text carrier returns the structured report", async () => {
  const { executor, signingTouched, llmCalls } = executorWithTrap();

  const result = await executor.dispatch({
    skill: SENTINEL_SKILL,
    ...NVDA_INTENT,
  });

  assert.equal(result.skill, SENTINEL_SKILL);
  assert.equal(result.error, undefined);
  const report = result.report as SentinelReport;
  assert.equal(report.version, "1");
  assert.equal(report.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(report.policy.outcome, "confirmation_required");
  assert.equal(report.opportunity.status, "needs_confirmation");
  assert.equal(report.execution.authorization, "none");
  assert.equal(report.execution.requiresUserReviewInEquiRoute, true);
  assert.match(String(result.explanation), /NVDA Market Sentinel/);

  // 21/22 — analysis touched neither signing nor the LLM work hook.
  assert.deepEqual(signingTouched, []);
  assert.deepEqual(llmCalls, []);
});

test("18. the A2A JSON-RPC entrypoint publishes the report as a data part", async () => {
  const { executor, signingTouched } = executorWithTrap();
  const published: Array<Record<string, unknown>> = [];
  let finished = false;

  const eventBus = {
    publish: (message: { parts?: Array<{ kind: string; data?: unknown }> }) => {
      for (const part of message.parts ?? []) {
        if (part.kind === "data") {
          published.push(part.data as Record<string, unknown>);
        }
      }
    },
    finished: () => {
      finished = true;
    },
  };
  const context = {
    contextId: "ctx-1",
    taskId: "task-1",
    userMessage: {
      parts: [{ kind: "data", data: { skill: SENTINEL_SKILL, ...NVDA_INTENT } }],
    },
  };

  await executor.execute(
    context as unknown as Parameters<typeof executor.execute>[0],
    eventBus as unknown as Parameters<typeof executor.execute>[1],
  );

  assert.equal(finished, true);
  assert.equal(published.length, 1);
  const payload = published[0] as { report: SentinelReport; explanation: string };
  assert.equal(payload.report.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(payload.report.execution.authorization, "none");
  assert.ok(payload.explanation.includes(BSTOCK_SHARES));
  assert.deepEqual(signingTouched, []);
});

test("18. the Sentinel skill is refused, not faked, when unconfigured", async () => {
  const trap = forbiddenSigning();
  const executor = new SellerAgentExecutor({
    runWork: async () => "unused",
    generator: "equiroutesentinel",
    sentinel: null,
    signing: trap.api as unknown as SigningApi,
  });
  const result = await executor.dispatch({ skill: SENTINEL_SKILL, ...NVDA_INTENT });
  assert.match(String(result.error), /not configured/);
  assert.equal(result.report, undefined);
  assert.equal((executor.skills() as string[]).includes(SENTINEL_SKILL), false);
});

// ── 19. MCP tool returns the report ─────────────────────────────────────────

async function mcpClient(): Promise<Client> {
  const server = buildMcpServer({
    commerceSkills: false,
    runWork: async () => {
      throw new Error("the LLM must not be the MCP analysis path");
    },
    sentinel: sentinelRunner(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

test("19. the MCP tool is read-only and returns the report", async () => {
  const client = await mcpClient();
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === SENTINEL_SKILL);
    assert.ok(tool !== undefined, "the Sentinel tool must be registered");
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.match(String(tool.description), /READ-ONLY ANALYSIS/);
    assert.match(String(tool.description), /authorization: "none"/);

    const result = (await client.callTool({
      name: SENTINEL_SKILL,
      arguments: { ...NVDA_INTENT },
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
      report: SentinelReport;
      explanation: string;
    };
    assert.equal(payload.report.version, "1");
    assert.equal(payload.report.selectedRepresentation?.symbol, "NVDAB");
    assert.equal(payload.report.selectedRepresentation?.normalizedUnderlyingShares, BSTOCK_SHARES);
    assert.equal(payload.report.policy.outcome, "confirmation_required");
    assert.equal(payload.report.opportunity.status, "needs_confirmation");
    assert.equal(payload.report.execution.authorization, "none");
    assert.equal(payload.report.execution.requiresUserReviewInEquiRoute, true);
    assert.match(payload.explanation, /NVDA Market Sentinel/);
  } finally {
    await client.close();
  }
});

test("19. the MCP face exposes no trading or wallet-spend tool", async () => {
  const client = await mcpClient();
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    // Commerce rail disabled → no signing tools at all.
    assert.equal(names.includes("negotiate"), false);
    assert.equal(names.includes("notify_funded"), false);
    for (const forbidden of [
      "execute_trade",
      "trade",
      "swap",
      "buy",
      "sell",
      "transfer",
      "approve",
      "sign",
      "sign_transaction",
      "send_transaction",
      "settle",
      "topup",
      "agentic_wallet",
      "agentic_wallet_preflight",
      "execution_gate",
    ]) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not exist`);
    }
    // Everything still present must be read-only.
    for (const tool of (await client.listTools()).tools) {
      assert.notEqual(
        tool.annotations?.readOnlyHint,
        false,
        `${tool.name} must be read-only`,
      );
    }
  } finally {
    await client.close();
  }
});

// ── 20. x402 remains free ───────────────────────────────────────────────────

test("20. the x402 seller face stays a FREE $0 passthrough", () => {
  const policy = B402SellerPolicy.fromToml(loadStudioToml());
  assert.equal(policy.enabled, true);
  // The b402 runtime treats /^0(?:\.0+)?$/ as FREE (no payment challenge).
  assert.equal(policy.priceUsd, "0");
  assert.match(policy.priceUsd, /^0(?:\.0+)?$/);
  // No payee override: nothing is redirected to a third party.
  assert.equal(policy.payTo, null);
});

test("20. a free x402 body routes to the deterministic Sentinel path", async () => {
  // studio-runtime's b402 `promptFrom` forwards `{"prompt": "..."}` verbatim.
  const body = JSON.stringify({ prompt: JSON.stringify({ skill: SENTINEL_SKILL, ...NVDA_INTENT }) });
  const prompt = (JSON.parse(body) as { prompt: string }).prompt;

  const request = sentinelIntentFromPrompt(prompt);
  assert.ok(request !== null, "the x402 body must be recognised as a Sentinel request");

  const deliverable = await sentinelRunner().analyze(request);
  const text = renderDeliverableText(deliverable);

  assert.ok(text.includes(REPORT_DELIMITER));
  const json = JSON.parse(text.split(REPORT_DELIMITER)[1] ?? "{}") as SentinelReport;
  assert.equal(json.selectedRepresentation?.symbol, "NVDAB");
  assert.equal(json.execution.authorization, "none");
  assert.equal(json.execution.requiresUserReviewInEquiRoute, true);
});

test("20. ordinary prose is not hijacked by the Sentinel path", () => {
  for (const prompt of [
    "Write me a poem about BNB Chain.",
    'Deliver the report. {"task": "summarise the whitepaper"}',
    '{"deliverables": "a market summary", "quality_standards": "accurate"}',
  ]) {
    assert.equal(sentinelIntentFromPrompt(prompt), null, prompt);
  }
  // An ERC-8183 job spec carrying a Sentinel request IS recognised.
  const job = JSON.stringify({
    task: "analyze tokenized equity",
    terms: { skill: SENTINEL_SKILL, ...NVDA_INTENT },
  });
  assert.notEqual(sentinelIntentFromPrompt(`JOB CONTEXT:\n${job}`), null);
});

// ── 21. No wallet spend ─────────────────────────────────────────────────────

test("21. analysis spends nothing: no wallet, no payment, no auto-topup", () => {
  const cfg = loadStudioToml() as Record<string, unknown>;

  // Auto-topup consent stays off, so no autonomous wallet spend can occur.
  const budget = (cfg.budget ?? {}) as Record<string, unknown>;
  assert.equal(budget.enabled, false);

  // The seller rail is free, so no payment is ever collected or required.
  const payments = (cfg.payments ?? {}) as Record<string, unknown>;
  const seller = (payments.seller ?? {}) as Record<string, unknown>;
  assert.equal(seller.price_usd, "0");

  // LLM stays on the $0 tier.
  const llm = (cfg.llm ?? {}) as Record<string, unknown>;
  assert.equal(llm.model, "auto/free");

  // The Sentinel source tree never reaches for wallet material or signing.
  for (const file of [
    "config.ts",
    "equirouteClient.ts",
    "explain.ts",
    "intent.ts",
    "report.ts",
    "request.ts",
    "runner.ts",
    "types.ts",
    "index.ts",
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf-8");
    for (const forbidden of [
      "signing.js",
      "studio-runtime/wallet",
      "getWallet",
      "WALLET_" + "PASSWORD",
      "PRIVATE_KEY",
      "agentic-wallet/preflight",
      "agentic-wallet/execution-gate",
      "x402Buyer",
      "buy_with_x402",
    ]) {
      assert.equal(
        source.includes(forbidden),
        false,
        `sentinel/${file} must not reference ${forbidden}`,
      );
    }
  }
});

// ── 22. No Studio signing exposed to the LLM ────────────────────────────────

test("22. the LLM tool set is read-only and holds no signing or Sentinel tool", () => {
  const names = Object.keys(LLM_READ_TOOLS);
  assert.ok(names.length > 0);

  for (const forbidden of [
    "sign",
    "sign_quote",
    "signQuote",
    "sign_transaction",
    "send_transaction",
    "submit_result",
    "submitResult",
    "settle",
    "negotiate",
    "notify_funded",
    "transfer",
    "approve",
    "swap",
    "trade",
    "execute_trade",
    "topup",
    "wallet_export",
    "wallet_private_key",
    SENTINEL_SKILL,
  ]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be an LLM tool`);
  }

  // Positively assert the surface is the expected read-only set.
  assert.deepEqual(names.sort(), [
    "agent_by_address",
    "agent_info",
    "balance_native",
    "balance_u",
    "job_list",
    "job_status",
    "network_info",
    "tx_status",
    "wallet_info",
  ]);
});

test("22. the Sentinel is fixed code, not an LLM-callable tool", () => {
  // The analysis path is reached through the A2A skill / MCP tool / runWork
  // value logic — never by the model choosing a tool.
  const names = Object.keys(LLM_READ_TOOLS);
  assert.equal(names.includes(SENTINEL_SKILL), false);

  const dualMain = readFileSync(new URL("../../dualMain.ts", import.meta.url), "utf-8");
  // The LLM tool set handed to generateText is unchanged.
  assert.match(dualMain, /tools: LLM_READ_TOOLS,/);
  // The Sentinel is composed in front of the LLM hook, not inside its tools.
  assert.match(dualMain, /sentinelIntentFromPrompt\(prompt\)/);
});
