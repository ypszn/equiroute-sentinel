/**
 * EquiRoute client: resilience + the execution boundary.
 *
 * Covers required cases 3 (unreachable), 4 (non-2xx), 5 (malformed response),
 * 16 (cannot invoke Agentic Wallet) and 17 (cannot invoke trade execution),
 * plus request timeout, schema validation and the auth-token seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEquiRouteConfig, CANONICAL_EQUIROUTE_BASE_URL, CANONICAL_QUOTE_CONTEXT_ADDRESS } from "../config.js";
import {
  ALLOWED_PATHS,
  assertAllowedPath,
  EquiRouteError,
  HttpEquiRouteClient,
  POLICY_PATH,
  ROUTE_PATH,
} from "../equirouteClient.js";
import { policyFixture, routeFixture, NVDA_INTENT } from "./fixtures.js";
import { startEquiRouteStub, unusedPort } from "./helpers.js";

const intent = { ...NVDA_INTENT };

function clientFor(baseUrl: string, timeoutMs = 5000): HttpEquiRouteClient {
  return new HttpEquiRouteClient({ config: { baseUrl, timeoutMs, headers: {}, source: "environment", quoteContextAddress: CANONICAL_QUOTE_CONTEXT_ADDRESS } });
}

// ── 3. EquiRoute unreachable ────────────────────────────────────────────────

test("3. EquiRoute unreachable is a typed error, never a fabricated result", async () => {
  const port = await unusedPort();
  const client = clientFor(`http://127.0.0.1:${port}`);

  await assert.rejects(
    () => client.getRoute(intent),
    (error: unknown) => {
      assert.ok(error instanceof EquiRouteError);
      assert.equal(error.kind, "unreachable");
      assert.equal(error.path, ROUTE_PATH);
      assert.match(error.describe(), /unreachable/i);
      return true;
    },
  );
});

test("request timeout is classified as a timeout, not as a result", async () => {
  const stub = await startEquiRouteStub({
    [ROUTE_PATH]: { json: routeFixture(), delayMs: 1000 },
  });
  try {
    const client = clientFor(stub.baseUrl, 60);
    await assert.rejects(
      () => client.getRoute(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "timeout");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

// ── 4. EquiRoute non-2xx ────────────────────────────────────────────────────

test("4. non-2xx carries the status and EquiRoute's own error string", async () => {
  const stub = await startEquiRouteStub({
    [ROUTE_PATH]: {
      status: 502,
      json: { error: "Routing failed upstream.", detail: "boom" },
    },
    [POLICY_PATH]: { status: 400, json: { error: "Malformed mandate" } },
  });
  try {
    const client = clientFor(stub.baseUrl);

    await assert.rejects(
      () => client.getRoute(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "http_error");
        assert.equal(error.status, 502);
        assert.equal(error.upstreamError, "Routing failed upstream.");
        return true;
      },
    );

    await assert.rejects(
      () => client.evaluatePolicy(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "http_error");
        assert.equal(error.status, 400);
        assert.equal(error.upstreamError, "Malformed mandate");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("non-2xx with a non-JSON body is still reported as the HTTP failure", async () => {
  const stub = await startEquiRouteStub({
    [ROUTE_PATH]: { status: 503, body: "<html>gateway</html>" },
  });
  try {
    await assert.rejects(
      () => clientFor(stub.baseUrl).getRoute(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "http_error");
        assert.equal(error.status, 503);
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

// ── 5. Malformed EquiRoute response ─────────────────────────────────────────

test("5. invalid JSON is rejected as invalid_json", async () => {
  const stub = await startEquiRouteStub({
    [ROUTE_PATH]: { status: 200, body: '{"intent": {' },
  });
  try {
    await assert.rejects(
      () => clientFor(stub.baseUrl).getRoute(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "invalid_json");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

test("5. a 200 body with the wrong shape fails schema validation", async () => {
  const stub = await startEquiRouteStub({
    // Valid JSON, wrong contract: `quotes` is not an array and `selected` is
    // missing entirely.
    [ROUTE_PATH]: { json: { intent: { ticker: "NVDA" }, quotes: "nope" } },
    [POLICY_PATH]: { json: { policyDecision: { outcome: "definitely" } } },
  });
  try {
    const client = clientFor(stub.baseUrl);
    await assert.rejects(
      () => client.getRoute(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "schema_invalid");
        return true;
      },
    );
    // An unknown policy outcome must never be accepted as a verdict.
    await assert.rejects(
      () => client.evaluatePolicy(intent),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "schema_invalid");
        return true;
      },
    );
  } finally {
    await stub.close();
  }
});

// ── 16 + 17. Execution boundary ─────────────────────────────────────────────

test("16. the Sentinel cannot invoke an Agentic Wallet endpoint", () => {
  for (const path of [
    "/api/agentic-wallet/preflight",
    "/api/agentic-wallet/execution-gate",
    "/api/agentic-wallet/status",
    "/api/agentic-wallet/capabilities",
  ]) {
    assert.throws(
      () => assertAllowedPath(path),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "forbidden_path");
        return true;
      },
      `${path} must be refused`,
    );
    assert.equal(ALLOWED_PATHS.includes(path), false);
  }
});

test("17. the Sentinel cannot invoke trade preparation or execution paths", () => {
  for (const path of [
    "/api/prepare",
    "/api/prepare/execute",
    "/api/execute",
    "/api/trade",
    "/api/swap",
  ]) {
    assert.throws(
      () => assertAllowedPath(path),
      (error: unknown) => {
        assert.ok(error instanceof EquiRouteError);
        assert.equal(error.kind, "forbidden_path");
        return true;
      },
      `${path} must be refused`,
    );
  }
});

test("only route discovery and policy evaluation are reachable", async () => {
  assert.deepEqual([...ALLOWED_PATHS], [ROUTE_PATH, POLICY_PATH]);
  assertAllowedPath(ROUTE_PATH);
  assertAllowedPath(POLICY_PATH);

  const stub = await startEquiRouteStub({
    [ROUTE_PATH]: { json: routeFixture() },
    [POLICY_PATH]: { json: policyFixture() },
  });
  try {
    const client = clientFor(stub.baseUrl);
    await client.getRoute(intent);
    await client.evaluatePolicy(intent);
    assert.deepEqual(stub.calls, [`POST ${ROUTE_PATH}`, `POST ${POLICY_PATH}`]);
  } finally {
    await stub.close();
  }
});

test("no wallet address is ever sent to EquiRoute", async () => {
  const bodies: string[] = [];
  const client = new HttpEquiRouteClient({
    config: { baseUrl: "http://equiroute.test", timeoutMs: 1000, headers: {}, source: "environment", quoteContextAddress: CANONICAL_QUOTE_CONTEXT_ADDRESS },
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify(policyFixture()),
      };
    },
  });
  await client.evaluatePolicy(intent);
  assert.equal(bodies.length, 1);
  const parsed = JSON.parse(bodies[0] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "notionalUsd",
    "slippagePercent",
    "ticker",
    "userWalletAddress",
  ]);
  assert.equal(parsed.userWalletAddress, CANONICAL_QUOTE_CONTEXT_ADDRESS);
});

// ── configuration ───────────────────────────────────────────────────────────

test("unset EquiRoute URL uses the canonical public deployment", () => {
  const config = loadEquiRouteConfig({});
  assert.equal(config.baseUrl, CANONICAL_EQUIROUTE_BASE_URL);
  assert.equal(config.source, "canonical_default");
});

test("explicit EquiRoute URL overrides the canonical default", () => {
  const config = loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "https://equiroute.example/" });
  assert.equal(config.baseUrl, "https://equiroute.example");
  assert.equal(config.source, "environment");
});

test("EQUIROUTE_BASE_URL validates HTTPS and rejects unsafe deployed overrides", () => {
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "http://localhost:3000", NODE_ENV: "production" }),
    /must use HTTPS/,
  );
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "https://localhost:3000", AGENTCORE_RUNTIME_URL: "https://runtime.example" }),
    /must not target localhost/,
  );
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "https://user:pass@equiroute.example", NODE_ENV: "production" }),
    /must not contain userinfo/,
  );
});

test("deployment EquiRoute dependency health validates configuration without routing", async () => {
  const { equiRouteDependencyStatus } = await import("../dependencyHealth.js");
  const ready = equiRouteDependencyStatus({ NODE_ENV: "production" });
  assert.equal(ready.configured, true);
  assert.equal(ready.reachable, null);
  assert.equal(ready.baseUrl, CANONICAL_EQUIROUTE_BASE_URL);
  assert.equal(ready.routeEndpointReady, "not_checked");
  assert.equal(ready.policyEndpointReady, "not_checked");
});

test("local localhost remains valid for local development", () => {
  assert.equal(loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "http://localhost:3000" }).baseUrl, "http://localhost:3000");
});

test("invalid non-http schemes remain refused", () => {
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "file:///etc/passwd" }),
    /must be http/,
  );
});


test("configured quote-context address is sent to both read-only EquiRoute passes", async () => {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const address = "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5";
  const client = new HttpEquiRouteClient({
    config: {
      baseUrl: "http://equiroute.test",
      timeoutMs: 1000,
      headers: {},
      source: "environment",
      quoteContextAddress: address,
    },
    fetchImpl: async (url, init) => {
      bodies.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      const value = new URL(url).pathname === ROUTE_PATH ? routeFixture() : policyFixture();
      return { status: 200, ok: true, text: async () => JSON.stringify(value) };
    },
  });

  await client.evaluatePolicy(intent);
  await client.getRoute(intent);
  assert.equal(client.quoteContextAddress(), address);
  assert.equal(bodies.length, 2);
  for (const call of bodies) {
    assert.equal(call.body.userWalletAddress, address);
    assert.equal("executionWallet" in call.body, false);
    assert.equal("signer" in call.body, false);
  }
  assert.deepEqual(
    bodies.map((call) => call.path),
    [POLICY_PATH, ROUTE_PATH],
  );
});

test("quote-context address validation accepts public addresses and rejects key-like values", () => {
  const address = "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5";
  assert.equal(
    loadEquiRouteConfig({ EQUIROUTE_QUOTE_WALLET_ADDRESS: address }).quoteContextAddress,
    address,
  );
  assert.equal(loadEquiRouteConfig({}).quoteContextAddress, CANONICAL_QUOTE_CONTEXT_ADDRESS);
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_QUOTE_WALLET_ADDRESS: "not-an-address" }),
    /must be a 0x-prefixed 20-byte public EVM address/,
  );
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_QUOTE_WALLET_ADDRESS: `0x${"a".repeat(64)}` }),
    /32-byte private key/,
  );
  assert.throws(
    () => loadEquiRouteConfig({ EQUIROUTE_QUOTE_WALLET_ADDRESS: "0x0000000000000000000000000000000000000000" }),
    /zero address/,
  );
});

test("quote-context address is never accepted from the Sentinel request", async () => {
  const bodies: string[] = [];
  const client = new HttpEquiRouteClient({
    config: {
      baseUrl: "http://equiroute.test",
      timeoutMs: 1000,
      headers: {},
      source: "environment",
      quoteContextAddress: "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5",
    },
    fetchImpl: async (_url, init) => {
      bodies.push(init.body);
      return { status: 200, ok: true, text: async () => JSON.stringify(routeFixture()) };
    },
  });
  await client.getRoute({ ...intent, quoteContextAddress: "0x1111111111111111111111111111111111111111" } as typeof intent & { quoteContextAddress: string });
  const sent = JSON.parse(bodies[0] as string) as Record<string, unknown>;
  assert.equal(sent.userWalletAddress, "0x30B146dF82aDB5e32155ea1bA94d016bf95bF2D5");
});
test("no credential is invented, but a token can be added later", async () => {
  // EquiRoute currently needs no auth: nothing is sent.
  assert.deepEqual(loadEquiRouteConfig({ EQUIROUTE_BASE_URL: "http://x.test" }).headers, {});

  const withToken = loadEquiRouteConfig({
    EQUIROUTE_BASE_URL: "http://x.test",
    EQUIROUTE_API_TOKEN: "tok-123",
  });
  assert.deepEqual(withToken.headers, { Authorization: "Bearer tok-123" });

  const seen: Record<string, string>[] = [];
  const client = new HttpEquiRouteClient({
    config: withToken,
    fetchImpl: async (_url, init) => {
      seen.push(init.headers);
      return { status: 200, ok: true, text: async () => JSON.stringify(routeFixture()) };
    },
  });
  await client.getRoute(intent);
  assert.equal(seen[0]?.Authorization, "Bearer tok-123");
});
