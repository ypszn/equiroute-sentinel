/**
 * Typed EquiRoute HTTP client — the Sentinel's ONLY door to EquiRoute.
 *
 * EquiRoute stays the authority for canonical representations, live quotes,
 * normalization, market regime, deterministic mandate evaluation and route
 * selection. This client transports those answers; it never reranks, recomputes
 * or second-guesses them.
 *
 * ## Execution boundary (enforced, not merely documented)
 *
 * Exactly two EquiRoute paths are reachable from here:
 *
 *     POST /api/route             route discovery
 *     POST /api/policy/evaluate   deterministic mandate evaluation
 *
 * {@link FORBIDDEN_PATH_PATTERNS} additionally fails closed on the agentic-wallet
 * and transaction-preparation endpoints. Those belong to the user's SEPARATE
 * Agentic Wallet review flow inside EquiRoute and must never be reachable from
 * autonomous Sentinel work.
 *
 * ## Resilience
 *
 * Every failure mode becomes a typed {@link EquiRouteError} — request timeout,
 * unreachable service, non-2xx, invalid JSON, schema drift. Callers turn those
 * into a safe report. Nothing here ever synthesises a quote or a policy result.
 */

import { z } from "zod";
import {
  DEFAULT_TIMEOUT_MS,
  type EquiRouteConfig,
  loadEquiRouteConfig,
} from "./config.js";
import {
  equiRouteErrorBodySchema,
  type PolicyInput,
  policyResultSchema,
  type PolicyResult,
  routeResultSchema,
  type RouteResult,
  type SentinelIntent,
} from "./types.js";

/** The only two EquiRoute paths autonomous Sentinel work may call. */
export const ROUTE_PATH = "/api/route";
export const POLICY_PATH = "/api/policy/evaluate";
export const ALLOWED_PATHS: readonly string[] = [ROUTE_PATH, POLICY_PATH];

/**
 * Paths the Sentinel must never call. The user's Agentic Wallet review and
 * unsigned-transaction preparation are a different trust boundary.
 */
export const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /^\/api\/agentic-wallet(\/|$)/u,
  /^\/api\/prepare(\/|$)/u,
];

export type EquiRouteErrorKind =
  | "config"
  | "timeout"
  | "unreachable"
  | "http_error"
  | "invalid_json"
  | "schema_invalid"
  | "forbidden_path";

/** Every EquiRoute failure the Sentinel can observe, classified. */
export class EquiRouteError extends Error {
  override readonly name = "EquiRouteError";
  readonly kind: EquiRouteErrorKind;
  readonly path: string;
  readonly status?: number;
  /** EquiRoute's own `error` string when it returned a structured body. */
  readonly upstreamError?: string;

  constructor(
    kind: EquiRouteErrorKind,
    path: string,
    message: string,
    extra: { status?: number; upstreamError?: string } = {},
  ) {
    super(message);
    this.kind = kind;
    this.path = path;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.upstreamError !== undefined) {
      this.upstreamError = extra.upstreamError;
    }
  }

  /** Short, operator-readable cause for a report / explanation. */
  describe(): string {
    switch (this.kind) {
      case "config":
        return `EquiRoute is not configured: ${this.message}`;
      case "timeout":
        return `EquiRoute did not respond in time (${this.path}).`;
      case "unreachable":
        return `EquiRoute is unreachable (${this.path}).`;
      case "http_error":
        return `EquiRoute returned HTTP ${this.status ?? "?"} for ${this.path}${
          this.upstreamError ? `: ${this.upstreamError}` : ""
        }`;
      case "invalid_json":
        return `EquiRoute returned a non-JSON body for ${this.path}.`;
      case "schema_invalid":
        return `EquiRoute returned an unexpected response shape for ${this.path}.`;
      case "forbidden_path":
        return `Refused to call ${this.path}: outside the Sentinel's read-only analysis boundary.`;
    }
  }
}

/** The Sentinel's view of EquiRoute. */
export interface EquiRouteClient {
  getRoute(input: SentinelIntent): Promise<RouteResult>;
  evaluatePolicy(input: PolicyInput): Promise<PolicyResult>;
  /**
   * The PUBLIC, read-only quote-context address this client sends, for report
   * provenance. Null when unconfigured. Carries no execution authority.
   */
  quoteContextAddress(): string | null;
}

/** Injectable fetch seam (tests pass a stub; runtime uses global fetch). */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly ok: boolean;
  text(): Promise<string>;
}>;

export interface HttpEquiRouteClientOptions {
  readonly config?: EquiRouteConfig;
  readonly fetchImpl?: FetchLike;
}

/** Fail closed before a request is ever built. */
export function assertAllowedPath(path: string): void {
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(path)) {
      throw new EquiRouteError(
        "forbidden_path",
        path,
        "agentic-wallet and transaction-preparation endpoints are not callable " +
          "from autonomous Sentinel work",
      );
    }
  }
  if (!ALLOWED_PATHS.includes(path)) {
    throw new EquiRouteError(
      "forbidden_path",
      path,
      `only ${ALLOWED_PATHS.join(" and ")} are reachable from the Sentinel`,
    );
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** HTTP implementation of {@link EquiRouteClient}. */
export class HttpEquiRouteClient implements EquiRouteClient {
  readonly #config: EquiRouteConfig | null;
  readonly #fetch: FetchLike;

  constructor(options: HttpEquiRouteClientOptions = {}) {
    this.#config = options.config ?? null;
    this.#fetch =
      options.fetchImpl ??
      ((input, init) =>
        fetch(input, init as unknown as RequestInit) as unknown as ReturnType<FetchLike>);
  }

  /** Resolved lazily so env changes between requests are honoured. */
  #resolveConfig(path: string): EquiRouteConfig {
    if (this.#config !== null) return this.#config;
    try {
      return loadEquiRouteConfig();
    } catch (error) {
      throw new EquiRouteError(
        "config",
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async #post<T>(
    path: string,
    body: Record<string, unknown>,
    schema: z.ZodType<T>,
    resolved?: EquiRouteConfig,
  ): Promise<T> {
    assertAllowedPath(path);
    const config = resolved ?? this.#resolveConfig(path);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    );
    timer.unref?.();

    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const response = await this.#fetch(`${config.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) {
        throw new EquiRouteError(
          "timeout",
          path,
          `request exceeded ${config.timeoutMs}ms`,
        );
      }
      throw new EquiRouteError(
        "unreachable",
        path,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A non-2xx with a non-JSON body is reported as the HTTP failure it is.
      if (!ok) {
        throw new EquiRouteError("http_error", path, `HTTP ${status}`, { status });
      }
      throw new EquiRouteError("invalid_json", path, "response body is not JSON");
    }

    if (!ok) {
      const errorBody = equiRouteErrorBodySchema.safeParse(parsed);
      throw new EquiRouteError("http_error", path, `HTTP ${status}`, {
        status,
        ...(errorBody.success ? { upstreamError: errorBody.data.error } : {}),
      });
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new EquiRouteError(
        "schema_invalid",
        path,
        result.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; "),
      );
    }
    return result.data;
  }

  /**
   * Route discovery. `/api/route` takes NO mandate (equiroute route.ts:60) —
   * it is the unconstrained candidate view and the source of the true
   * quote-level rejection reasons.
   *
   * `userWalletAddress` is EquiRoute's field name for the address an RFQ
   * representation needs in order to RETURN a quote. The value is the
   * server-configured, read-only quote-context address — never a
   * caller-supplied one, and never an execution authority.
   */
  async getRoute(input: SentinelIntent): Promise<RouteResult> {
    const config = this.#resolveConfig(ROUTE_PATH);
    const body: Record<string, unknown> = {
      ticker: input.ticker,
      notionalUsd: input.notionalUsd,
    };
    if (config.quoteContextAddress !== null) {
      body.userWalletAddress = config.quoteContextAddress;
    }
    return this.#post(ROUTE_PATH, body, routeResultSchema, config);
  }

  /**
   * Deterministic mandate evaluation. `mandate` is forwarded verbatim (or
   * omitted so EquiRoute applies its own DEFAULT_MANDATE).
   *
   * The same read-only quote-context address is sent so this pass prices the
   * SAME candidate set as route discovery; otherwise the mandate would be
   * evaluated against a strictly smaller set of representations. It is quote
   * context only: this endpoint neither prepares nor authorizes anything.
   */
  async evaluatePolicy(input: PolicyInput): Promise<PolicyResult> {
    const config = this.#resolveConfig(POLICY_PATH);
    const body: Record<string, unknown> = {
      ticker: input.ticker,
      notionalUsd: input.notionalUsd,
      slippagePercent: input.slippagePercent,
    };
    if (input.mandate !== undefined) body.mandate = input.mandate;
    if (config.quoteContextAddress !== null) {
      body.userWalletAddress = config.quoteContextAddress;
    }
    return this.#post(POLICY_PATH, body, policyResultSchema, config);
  }

  /** Report provenance: the public address actually sent, or null. */
  quoteContextAddress(): string | null {
    try {
      return this.#resolveConfig("<config>").quoteContextAddress ?? null;
    } catch {
      // A broken config surfaces as an EquiRouteError on the request itself;
      // provenance simply reports that no address was used.
      return null;
    }
  }
}
