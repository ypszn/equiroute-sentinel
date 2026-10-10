/**
 * EquiRoute Market Sentinel — public surface.
 *
 * The Sentinel is an autonomous analysis/orchestration layer over EquiRoute.
 * EquiRoute stays the authority for canonical tokenized-equity
 * representations, live quotes, normalization, market regime, deterministic
 * mandate evaluation and route selection. The Sentinel explains that result and
 * never reranks or overrides it.
 *
 * Hard boundaries enforced by this module tree:
 *  - Only `/api/route` and `/api/policy/evaluate` are reachable
 *    (equirouteClient.ts). The agentic-wallet and prepare endpoints fail closed.
 *  - Every report carries `authorization: "none"` and
 *    `requiresUserReviewInEquiRoute: true` (report.ts).
 *  - Numbers are formatted from the structured report in fixed code; LLM
 *    commentary is numerically guarded or discarded (explain.ts).
 *  - Nothing here imports `signing.ts` or touches wallet material.
 */

export {
  equiRouteDependencyStatus,
  withEndpointReadiness,
  type DependencyReadiness,
  type EquiRouteDependencyStatus,
} from "./dependencyHealth.js";


export {
  CANONICAL_EQUIROUTE_BASE_URL,
  CANONICAL_QUOTE_CONTEXT_ADDRESS,
  DEFAULT_TIMEOUT_MS,
  EquiRouteConfigError,
  loadEquiRouteConfig,
  type EquiRouteConfig,
} from "./config.js";

export {
  ALLOWED_PATHS,
  assertAllowedPath,
  EquiRouteError,
  FORBIDDEN_PATH_PATTERNS,
  HttpEquiRouteClient,
  POLICY_PATH,
  ROUTE_PATH,
  type EquiRouteClient,
  type EquiRouteErrorKind,
  type FetchLike,
} from "./equirouteClient.js";

export {
  commentaryPrompt,
  explainSentinelReport,
  guardCommentary,
  renderSentinelReport,
  reportNumbers,
  stripReasoning,
  type CommentaryModel,
} from "./explain.js";

export {
  DEFAULT_SLIPPAGE_PERCENT,
  SentinelInputError,
  validateSentinelIntent,
} from "./intent.js";

export {
  buildSentinelReport,
  buildUnavailableReport,
  classifyOpportunity,
  type Clock,
} from "./report.js";

export {
  buildSentinelWorkHook,
  modelUnavailableDeliverable,
  sanitizeDeliverableText,
  sentinelUnavailableDeliverable,
  type LlmWorkHook,
  type SentinelWorkHookOptions,
} from "./delivery.js";

export {
  MARKET_WATCH_SKILL,
  marketWatchFromPayload,
  SENTINEL_SKILL,
  sentinelIntentFromJobText,
  sentinelJobRequestFromPrompt,
  sentinelIntentFromPayload,
  sentinelIntentFromPrompt,
  watchFromPrompt,
} from "./request.js";

export {
  createSentinelRunner,
  renderDeliverableText,
  REPORT_DELIMITER,
  type SentinelRunner,
  type SentinelRunnerOptions,
} from "./runner.js";

export {
  evaluateMarketWatch,
  MarketWatchInputError,
  validateMarketWatch,
  watchDeliverable,
  watchToPrompt,
  type MarketWatch,
  type WatchConditionResult,
  type WatchDeliverable,
  type WatchEvaluation,
} from "./watch.js";

export {
  EQUIROUTE_PROVIDERS,
  MARKET_REGIMES,
  OPPORTUNITY_STATUSES,
  REJECTION_CLASSES,
  type ExecutionMandateInput,
  type MarketRegime,
  type OpportunityStatus,
  type PolicyDecision,
  type PolicyInput,
  type PolicyOutcome,
  type PolicyResult,
  type RejectionClass,
  type RouteResult,
  type SentinelAlternative,
  type SentinelDeliverable,
  type SentinelIntent,
  type SentinelReport,
  type SentinelSelectedRepresentation,
} from "./types.js";
