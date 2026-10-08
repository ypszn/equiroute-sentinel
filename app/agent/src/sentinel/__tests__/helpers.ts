/**
 * Test helpers: a real local EquiRoute stub server, and in-memory clients.
 *
 * The stub is a genuine `node:http` listener on an ephemeral port, so the
 * client's timeout / non-2xx / malformed-JSON / unreachable paths are exercised
 * over a real socket rather than against a mocked `fetch`.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { EquiRouteClient } from "../equirouteClient.js";
import type { PolicyInput, PolicyResult, RouteResult, SentinelIntent } from "../types.js";

export interface StubResponse {
  status?: number;
  /** Raw body. Use this to emit malformed JSON. */
  body?: string;
  json?: unknown;
  /** Delay before responding, to trigger the client timeout. */
  delayMs?: number;
}

export interface EquiRouteStub {
  readonly baseUrl: string;
  /** Paths that were actually requested, in order. */
  readonly calls: string[];
  close(): Promise<void>;
}

/** Start a stub EquiRoute on an ephemeral port. */
export async function startEquiRouteStub(
  handlers: Record<string, StubResponse | (() => StubResponse)>,
): Promise<EquiRouteStub> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    calls.push(`${req.method} ${path}`);
    // Drain the body so the socket does not stall.
    req.resume();
    req.on("end", () => {
      const entry = handlers[path];
      if (entry === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const spec = typeof entry === "function" ? entry() : entry;
      const send = (): void => {
        const body =
          spec.body !== undefined ? spec.body : JSON.stringify(spec.json ?? {});
        res.writeHead(spec.status ?? 200, { "Content-Type": "application/json" });
        res.end(body);
      };
      if (spec.delayMs !== undefined && spec.delayMs > 0) {
        setTimeout(send, spec.delayMs).unref?.();
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port that is listening and then closed — i.e. refuses connections. */
export async function unusedPort(): Promise<number> {
  const stub = await startEquiRouteStub({});
  const port = Number(new URL(stub.baseUrl).port);
  await stub.close();
  return port;
}

export interface FakeClientOptions {
  route?: RouteResult | (() => RouteResult | Promise<RouteResult>);
  policy?: PolicyResult | (() => PolicyResult | Promise<PolicyResult>);
  routeError?: Error;
  policyError?: Error;
  quoteContextAddress?: string | null;
}

export interface FakeClient extends EquiRouteClient {
  readonly routeCalls: SentinelIntent[];
  readonly policyCalls: PolicyInput[];
}

/** In-memory {@link EquiRouteClient} for report/classification tests. */
export function fakeClient(options: FakeClientOptions): FakeClient {
  const routeCalls: SentinelIntent[] = [];
  const policyCalls: PolicyInput[] = [];
  return {
    routeCalls,
    policyCalls,
    quoteContextAddress: () => options.quoteContextAddress ?? null,
    async getRoute(input) {
      routeCalls.push(input);
      if (options.routeError) throw options.routeError;
      if (options.route === undefined) throw new Error("no route fixture configured");
      return typeof options.route === "function" ? options.route() : options.route;
    },
    async evaluatePolicy(input) {
      policyCalls.push(input);
      if (options.policyError) throw options.policyError;
      if (options.policy === undefined) throw new Error("no policy fixture configured");
      return typeof options.policy === "function" ? options.policy() : options.policy;
    },
  };
}

/** Fixed clock so `generatedAt` is reproducible. */
export const FIXED_NOW = "2026-10-08T12:00:00.000Z";
export const fixedClock = (): Date => new Date(FIXED_NOW);

/** A signing API that fails loudly if the Sentinel path ever touches it. */
export function forbiddenSigning(): {
  api: Record<string, (...args: unknown[]) => never>;
  readonly touched: string[];
} {
  const touched: string[] = [];
  const trap = (name: string) => (): never => {
    touched.push(name);
    throw new Error(`signing.${name} must never be reached by Sentinel analysis`);
  };
  return {
    touched,
    api: {
      listPrice: trap("listPrice"),
      clampPrice: trap("clampPrice"),
      signQuote: trap("signQuote"),
      verifySignedJob: trap("verifySignedJob"),
      jobSpec: trap("jobSpec"),
      submitResult: trap("submitResult"),
    },
  };
}
