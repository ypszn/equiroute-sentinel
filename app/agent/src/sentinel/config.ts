/**
 * EquiRoute connection configuration — server-side env only.
 *
 * `EQUIROUTE_BASE_URL` is the ONE knob that points the Sentinel at an
 * EquiRoute deployment. It is read from the process environment at call time
 * (not cached at import) so `bag dev` / the deployed runtime secret bundle can
 * set it before the first request.
 *
 * Localhost is a LOCAL-DEV convenience only: the fallback applies when the
 * process is demonstrably not a deployed runtime (no AgentCore runtime URL and
 * no managed secret bundle). A deployed runtime with no `EQUIROUTE_BASE_URL`
 * fails loudly instead of silently analysing a localhost that does not exist —
 * the Sentinel must never fabricate an opportunity.
 *
 * `EQUIROUTE_QUOTE_WALLET_ADDRESS` is a PUBLIC EVM address used ONLY as
 * read-only quote context: some EquiRoute representations price through an RFQ
 * mechanism that will not return a quote without an address to quote against
 * (observed live: `40001` / "userWalletAddress is required for RFQ (…) quote").
 * Without it, those representations drop out of the comparison entirely.
 *
 * It is NOT an execution wallet. It confers no authority: the Sentinel never
 * signs, never prepares a transaction, never calls `/api/prepare` or
 * `/api/agentic-wallet/*`, and never implies that this address will execute
 * anything. Execution stays with the user, in EquiRoute, behind their own
 * Agentic Wallet review. See `quoteContext` provenance on every report.
 *
 * It is deliberately SERVER-SIDE ONLY — never taken from a request — so the
 * agent cannot be driven as an RFQ oracle for arbitrary third-party addresses.
 *
 * Authentication: EquiRoute currently requires NO credential for
 * `/api/route` and `/api/policy/evaluate`. No credential is invented here. The
 * optional `EQUIROUTE_API_TOKEN` seam exists so a token can be added later
 * without restructuring the client: when unset, NO auth header is sent.
 */

/** Local-dev default; never used when the process looks like a deployed runtime. */
export const LOCAL_DEV_BASE_URL = "http://localhost:3000";

/** Default per-request ceiling. EquiRoute fans out 3 quotes + market status. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** A public EVM address: 20 bytes, hex, 0x-prefixed. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface EquiRouteConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Extra headers to send (auth seam). Empty when no token is configured. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * PUBLIC address used only so RFQ representations will return a readable
   * quote. Carries NO execution authority. Null when unconfigured, in which
   * case RFQ representations are reported as
   * `QUOTE_CONTEXT_ADDRESS_REQUIRED` rather than as economically worse.
   */
  readonly quoteContextAddress?: string | null;
}

export class EquiRouteConfigError extends Error {
  override readonly name = "EquiRouteConfigError";
}

/**
 * True when this process is a deployed runtime rather than local `bag dev`.
 *
 * Uses the scaffold's own deployed-runtime signals (see dualMain.ts):
 * `AGENTCORE_RUNTIME_URL` is injected by the platform and
 * `BNBAGENT_RUNTIME_SECRET_ID` names the managed secret bundle.
 */
function isDeployedRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.AGENTCORE_RUNTIME_URL ||
      env.BNBAGENT_RUNTIME_SECRET_ID ||
      env.NODE_ENV === "production" ||
      env.STUDIO_DEPLOYED_RUNTIME === "true",
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/u.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Normalise a base URL: http/https only, no query, no fragment, no trailing
 * slash. Rejecting other schemes keeps `file:`/`data:` and friends out of the
 * request path even if the env is misconfigured.
 */
function normaliseBaseUrl(raw: string, deployed: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new EquiRouteConfigError(
      `EQUIROUTE_BASE_URL is not a valid absolute URL: ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EquiRouteConfigError(
      `EQUIROUTE_BASE_URL must be http(s); got ${JSON.stringify(parsed.protocol)}`,
    );
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" && !/^\d+$/u.test(parsed.port)
  ) {
    throw new EquiRouteConfigError(
      "EQUIROUTE_BASE_URL must not contain userinfo or an invalid port.",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new EquiRouteConfigError(
      "EQUIROUTE_BASE_URL must not carry a query string or fragment",
    );
  }
  if (deployed && parsed.protocol !== "https:") {
    throw new EquiRouteConfigError(
      "EQUIROUTE_BASE_URL must use HTTPS in deployed/production mode.",
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback =
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    hostname.endsWith(".localhost");
  if (deployed && loopback) {
    throw new EquiRouteConfigError(
      "EQUIROUTE_BASE_URL must not target localhost or loopback in deployed/production mode.",
    );
  }
  const path = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.origin}${path}`;
}

/**
 * Optional auth headers. Nothing is sent unless the operator configured a
 * token, so no credential is invented for an endpoint that needs none.
 */
function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = (env.EQUIROUTE_API_TOKEN ?? "").trim();
  if (token === "") return {};
  const header = (env.EQUIROUTE_AUTH_HEADER ?? "Authorization").trim();
  if (!/^[A-Za-z0-9-]+$/u.test(header)) {
    throw new EquiRouteConfigError(
      "EQUIROUTE_AUTH_HEADER must be a simple header name",
    );
  }
  const scheme = (env.EQUIROUTE_AUTH_SCHEME ?? "Bearer").trim();
  return { [header]: scheme === "" ? token : `${scheme} ${token}` };
}

/**
 * Resolve the read-only quote-context address.
 *
 * Accepts ONLY a public 20-byte EVM address. Anything that could be key
 * material is refused loudly, and no rejected value is ever echoed into the
 * error message (so a mis-pasted secret cannot leak into logs or a report).
 */
function resolveQuoteContextAddress(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.EQUIROUTE_QUOTE_WALLET_ADDRESS ?? "").trim();
  if (raw === "") return null;

  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (/^[0-9a-fA-F]{64}$/u.test(hex)) {
    throw new EquiRouteConfigError(
      "EQUIROUTE_QUOTE_WALLET_ADDRESS looks like a 32-byte private key, not a " +
        "public address. The Sentinel needs only a PUBLIC address for read-only " +
        "quote context and must never be given key material. Value not echoed.",
    );
  }
  if (!EVM_ADDRESS.test(raw)) {
    throw new EquiRouteConfigError(
      "EQUIROUTE_QUOTE_WALLET_ADDRESS must be a 0x-prefixed 20-byte public EVM " +
        "address. Value not echoed.",
    );
  }
  if (raw.toLowerCase() === ZERO_ADDRESS) {
    throw new EquiRouteConfigError(
      "EQUIROUTE_QUOTE_WALLET_ADDRESS must not be the zero address.",
    );
  }
  return raw;
}

/** Resolve the EquiRoute connection config, or throw {@link EquiRouteConfigError}. */
export function loadEquiRouteConfig(
  env: NodeJS.ProcessEnv = process.env,
): EquiRouteConfig {
  const quoteContextAddress = resolveQuoteContextAddress(env);
  const deployed = isDeployedRuntime(env);
  const raw = (env.EQUIROUTE_BASE_URL ?? "").trim();
  if (raw === "") {
    if (isDeployedRuntime(env)) {
      throw new EquiRouteConfigError(
        "EQUIROUTE_BASE_URL is not set. The Sentinel has no EquiRoute " +
          "endpoint to analyse against and will not guess one in a deployed " +
          "runtime. Set EQUIROUTE_BASE_URL in the runtime environment.",
      );
    }
    return {
      baseUrl: LOCAL_DEV_BASE_URL,
      timeoutMs: positiveInt(env.EQUIROUTE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      headers: authHeaders(env),
      quoteContextAddress,
    };
  }
  return {
    baseUrl: normaliseBaseUrl(raw, deployed),
    timeoutMs: positiveInt(env.EQUIROUTE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    headers: authHeaders(env),
    quoteContextAddress,
  };
}
