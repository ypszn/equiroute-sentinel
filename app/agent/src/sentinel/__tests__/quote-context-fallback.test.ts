import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_QUOTE_CONTEXT_ADDRESS,
  loadEquiRouteConfig,
} from "../config.js";
import { createSentinelRunner } from "../runner.js";
import { routeFixture, policyFixture, NVDA_INTENT } from "./fixtures.js";
import { fakeClient, fixedClock } from "./helpers.js";

test("no quote-context env override resolves to the public canonical quote-context address", () => {
  const config = loadEquiRouteConfig({});
  assert.equal(config.quoteContextAddress, CANONICAL_QUOTE_CONTEXT_ADDRESS);
  assert.equal(config.quoteContextAddress, "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5");
});

test("a valid quote-context env override takes precedence", () => {
  const override = "0x1111111111111111111111111111111111111111";
  const config = loadEquiRouteConfig({ EQUIROUTE_QUOTE_WALLET_ADDRESS: override });
  assert.equal(config.quoteContextAddress, override);
});

test("analysis provenance records canonical address and never grants authority", async () => {
  const runner = createSentinelRunner({
    client: fakeClient({
      route: routeFixture(),
      policy: policyFixture(),
      quoteContextAddress: CANONICAL_QUOTE_CONTEXT_ADDRESS,
    }),
    model: null,
    clock: fixedClock,
  });
  const { report } = await runner.analyze({ ...NVDA_INTENT });
  assert.equal(report.quoteContext.addressUsed, CANONICAL_QUOTE_CONTEXT_ADDRESS);
  assert.equal(report.quoteContext.purpose, "read_only_quote_context");
  assert.equal(report.quoteContext.executionAuthority, false);
  assert.equal(report.execution.authorization, "none");
  assert.equal(report.execution.requiresUserReviewInEquiRoute, true);
});

test("request-supplied addresses do not change quote-context config or execution authority", async () => {
  const runner = createSentinelRunner({
    client: fakeClient({
      route: routeFixture(),
      policy: policyFixture(),
      quoteContextAddress: CANONICAL_QUOTE_CONTEXT_ADDRESS,
    }),
    model: null,
    clock: fixedClock,
  });
  const requestAddress = "0x2222222222222222222222222222222222222222";
  const { report } = await runner.analyze({
    ...NVDA_INTENT,
    userWalletAddress: requestAddress,
    quoteContextAddress: requestAddress,
  });
  assert.equal(report.quoteContext.addressUsed, CANONICAL_QUOTE_CONTEXT_ADDRESS);
  assert.equal(report.quoteContext.executionAuthority, false);
  assert.equal(report.execution.authorization, "none");
  assert.equal(report.execution.requiresUserReviewInEquiRoute, true);
});
