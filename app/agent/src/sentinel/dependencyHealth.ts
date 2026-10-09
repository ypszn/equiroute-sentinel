import { EquiRouteConfigError, loadEquiRouteConfig } from "./config.js";
import type { EquiRouteConfig } from "./config.js";

export type DependencyReadiness = "ready" | "not_checked" | "failed";

export type EquiRouteDependencyStatus = {
  configured: boolean;
  reachable: boolean | null;
  baseUrl: string | null;
  routeEndpointReady: DependencyReadiness;
  policyEndpointReady: DependencyReadiness;
  reason?: string;
};

/**
 * Return deterministic EquiRoute dependency status without making a network
 * request. EquiRoute has no cheap documented health endpoint in the inspected
 * API, and calling `/api/route` here would trigger live market/RFQ providers.
 * Actual endpoint readiness is established only by a successful validated
 * Sentinel request.
 */
export function equiRouteDependencyStatus(
  env: NodeJS.ProcessEnv = process.env,
): EquiRouteDependencyStatus {
  try {
    const config: EquiRouteConfig = loadEquiRouteConfig(env);
    const deployed = Boolean(
      env.AGENTCORE_RUNTIME_URL ||
        env.BNBAGENT_RUNTIME_SECRET_ID ||
        env.NODE_ENV === "production" ||
        env.STUDIO_DEPLOYED_RUNTIME === "true",
    );
    return {
      configured: true,
      reachable: null,
      baseUrl: config.baseUrl,
      routeEndpointReady: "not_checked",
      policyEndpointReady: "not_checked",
      reason: deployed
        ? `Configuration validated from ${config.source}. Reachability and endpoint readiness are checked by the next validated Sentinel request; no routing probe was issued.`
        : `Configuration validated from ${config.source}. No market-routing probe was issued.`,
    };
  } catch (error) {
    const reason = error instanceof EquiRouteConfigError || error instanceof Error
      ? error.message
      : "EquiRoute configuration is invalid.";
    return {
      configured: false,
      reachable: false,
      baseUrl: null,
      routeEndpointReady: "failed",
      policyEndpointReady: "failed",
      reason,
    };
  }
}

/** Mark a validated endpoint result after actual Sentinel traffic. */
export function withEndpointReadiness(
  prior: EquiRouteDependencyStatus,
  endpoint: "route" | "policy",
  ready: boolean,
): EquiRouteDependencyStatus {
  return {
    ...prior,
    reachable: ready || prior.reachable === true,
    routeEndpointReady:
      endpoint === "route" ? (ready ? "ready" : "failed") : prior.routeEndpointReady,
    policyEndpointReady:
      endpoint === "policy" ? (ready ? "ready" : "failed") : prior.policyEndpointReady,
  };
}
