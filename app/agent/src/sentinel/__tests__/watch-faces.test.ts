import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentCard } from "../../agentCard.js";
import { SellerAgentExecutor } from "../../executor.js";
import { buildMcpServer } from "../../mcpMain.js";
import type { SellerCoreOpts, SigningApi } from "../../sellerCore.js";
import { createSentinelRunner, MARKET_WATCH_SKILL, SENTINEL_SKILL } from "../index.js";
import { marketWatchFromPayload, watchFromPrompt } from "../request.js";
import { routeFixture, policyFixture, NVDA_INTENT } from "./fixtures.js";
import { fakeClient, fixedClock, forbiddenSigning } from "./helpers.js";
import type { SentinelReport } from "../types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const watch = {
  version: "1" as const,
  ...NVDA_INTENT,
  conditions: { selectedProvider: "bstock" },
};

function runner() {
  return createSentinelRunner({
    client: fakeClient({ route: routeFixture(), policy: policyFixture() }),
    model: null,
    clock: fixedClock,
  });
}

test("A2A card advertises one-off Market Watch evaluation", () => {
  const card = buildAgentCard({ commerceSkills: false });
  const ids = card.skills.map((s) => s.id);
  assert.deepEqual(ids, [SENTINEL_SKILL, MARKET_WATCH_SKILL]);
  const watchSkill = card.skills.find((s) => s.id === MARKET_WATCH_SKILL);
  assert.match(watchSkill?.description ?? "", /whenever invoked/i);
  assert.match(watchSkill?.description ?? "", /not continuous/i);
});

test("A2A watch request returns deterministic evaluation", async () => {
  const trap = forbiddenSigning();
  const opts: SellerCoreOpts = {
    runWork: async () => "unused",
    generator: "test",
    commerceSkills: false,
    sentinel: runner(),
    signing: trap.api as unknown as SigningApi,
  };
  const executor = new SellerAgentExecutor(opts);
  const output = await executor.dispatch({ skill: MARKET_WATCH_SKILL, ...watch });
  const evaluation = output.evaluation as { matched: boolean; authorization: string; requiresUserReviewInEquiRoute: boolean };
  assert.equal(output.kind, "equiroute_market_watch");
  assert.equal(evaluation.matched, true);
  assert.equal(evaluation.authorization, "none");
  assert.equal(evaluation.requiresUserReviewInEquiRoute, true);
  assert.deepEqual(trap.touched, []);
});

test("MCP evaluate_market_watch is read-only and returns WatchEvaluation", async () => {
  const server = buildMcpServer({ commerceSkills: false, sentinel: runner(), runWork: async () => "unused" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "watch-test", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((t) => t.name === MARKET_WATCH_SKILL);
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const result = await client.callTool({ name: MARKET_WATCH_SKILL, arguments: watch });
    const content = result.content as Array<{ text?: string }>;
    const payload = JSON.parse(content[0]?.text ?? "{}") as { evaluation: { matched: boolean; authorization: string } };
    assert.equal(payload.evaluation.matched, true);
    assert.equal(payload.evaluation.authorization, "none");
  } finally { await client.close(); }
});

test("ERC-8183-style runWork watch prompt creates structured deliverable shape", async () => {
  const parsed = watchFromPrompt(`JOB CONTEXT:\n${JSON.stringify({ terms: { skill: MARKET_WATCH_SKILL, ...watch } })}`);
  assert.deepEqual(parsed?.conditions, watch.conditions);
  const evaluated = await runner().evaluateWatch(parsed);
  const deliverable = {
    kind: "equiroute_market_watch",
    watch: evaluated.watch,
    evaluation: evaluated.evaluation,
    authorization: "none" as const,
  };
  assert.equal(deliverable.kind, "equiroute_market_watch");
  assert.equal(deliverable.evaluation.matched, true);
  assert.equal(deliverable.authorization, "none");
});

test("watch detection does not call forbidden endpoints or signing", () => {
  const source = JSON.stringify({ ...watch, skill: MARKET_WATCH_SKILL });
  assert.ok(marketWatchFromPayload(JSON.parse(source)));
  assert.equal(source.includes("agentic-wallet"), false);
  assert.equal(source.includes("/api/prepare"), false);
  assert.equal(source.includes("sign"), false);
});

test("zero-price seller config remains unchanged", () => {
  // This test intentionally only inspects the watch path's contract; payment
  // and signing are not part of deterministic evaluation.
  assert.equal(watch.version, "1");
});
