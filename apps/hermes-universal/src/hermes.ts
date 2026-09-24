// The desktop REST/WS client, split by domain under src/api/. This module is
// the compatibility barrel: every helper keeps its historical `@/hermes`
// import path while the implementations live in focused files.
// client is the one module with internals: profileScoped / connectionScoped /
// capabilityScoped are shared across api/ but must not reach call sites, or
// request scoping stops having a single owner.
import { JsonRpcGatewayClient } from '@hermes/shared'

import { profileScoped, socketProfile } from './transport/gateway-profile'
import { openGatewaySocket } from './transport/gateway-socket'

export {
  getApiRequestConnection,
  getApiRequestProfile,
  hermesApi,
  profileScopeKey,
  PROMPT_SUBMIT_REQUEST_TIMEOUT_MS,
  setApiRequestConnection,
  setApiRequestProfile,
  STARTUP_REQUEST_TIMEOUT_MS
} from './api/client'
export type { ProfileScope } from './api/client'
export * from './api/config'
export * from './api/cron'
export * from './api/local-models'
export * from './api/mcp'
export * from './api/messaging'
export * from './api/models'
export * from './api/plugins'
export * from './api/profiles'
export * from './api/sessions'
export * from './api/skills'
export * from './api/system'
export * from './api/toolsets'

export type {
  ActionResponse,
  ActionStatusResponse,
  AnalyticsDailyEntry,
  AnalyticsModelEntry,
  AnalyticsResponse,
  AnalyticsSkillEntry,
  AnalyticsSkillsSummary,
  AnalyticsTotals,
  AudioSpeakResponse,
  AudioTranscriptionResponse,
  AudioTtsLeaseResponse,
  AutomationBlueprint,
  AutomationBlueprintField,
  AuxiliaryModelsResponse,
  AuxiliaryTaskAssignment,
  BackendUpdateCheckResponse,
  ComputerUseCheck,
  ComputerUsePermissionSource,
  ComputerUseStatus,
  ConfigFieldSchema,
  ConfigSchemaResponse,
  CronDeliveryTarget,
  CronJob,
  CronJobCreatePayload,
  CronJobSchedule,
  CronJobUpdates,
  CuratorStatusResponse,
  CustomEndpoint,
  CustomEndpointsResponse,
  CustomEndpointUpdate,
  CustomEndpointValidationResponse,
  DebugShareResponse,
  ElevenLabsVoice,
  ElevenLabsVoicesResponse,
  EnvVarInfo,
  HermesConfig,
  HermesConfigRecord,
  LogsResponse,
  McpCatalogEntry,
  McpCatalogResponse,
  McpServerSummary,
  McpServerTestResponse,
  MemoryProviderConfig,
  MemoryProviderOAuthStatus,
  MemoryStatusResponse,
  MessagingEnvVarInfo,
  MessagingHomeChannel,
  MessagingPlatformInfo,
  MessagingPlatformsResponse,
  MessagingPlatformTestResponse,
  MessagingPlatformUpdate,
  MoaConfigResponse,
  MoaModelSlot,
  ModelAssignmentRequest,
  ModelAssignmentResponse,
  ModelInfoResponse,
  PaginatedSessions,
  PairingResponse,
  PairingUser,
  ProfileCreatePayload,
  ProfileDesktopOverlay,
  ProfileInfo,
  ProfileSetupCommand,
  ProfileSoul,
  ProfilesResponse,
  ProjectFolder,
  ProjectInfo,
  ProjectsPayload,
  SessionCreateResponse,
  SessionInfo,
  SessionMessage,
  SessionMessagesResponse,
  SessionResumeResult,
  SessionRuntimeInfo,
  SessionSearchResponse,
  SessionSearchResult,
  SkillHubInstalledEntry,
  SkillHubPreview,
  SkillHubResult,
  SkillHubScanResult,
  SkillHubSearchResponse,
  SkillHubSource,
  SkillHubSourcesResponse,
  SkillInfo,
  StaleAuxAssignment,
  StarmapGraph,
  StatusResponse,
  TelegramOnboardingApplyResponse,
  TelegramOnboardingStartResponse,
  TelegramOnboardingStatusResponse,
  ToolsetConfig,
  ToolsetInfo,
  ToolsetModel,
  ToolsetModelsResponse,
  WebhookCreatePayload,
  WebhookCreateResponse,
  WebhookEnableResponse,
  WebhookRoute,
  WebhooksResponse
} from '@/types/hermes'

// Universal's own API surface, appended so the block above stays desktop's line
// for line. See src/api/universal.ts for what qualifies and what does not.
// eslint-disable-next-line perfectionist/sort-exports -- appended on purpose
export * from './api/universal'

/**
 * The other divergence: `HermesGateway` is defined here, not re-exported from
 * `./api/client`. Desktop's opens a browser `WebSocket`; the webview cannot, so
 * this one is the same client — desktop's options, value for value — over the
 * Rust transport (`transport/gateway-socket.ts`). Desktop's registry and boot
 * hook construct it from `@/hermes` unchanged.
 *
 * And it names its profile. Desktop's socket is its profile's own backend; here
 * one backend serves every profile and an RPC says which, so the client learns
 * its profile from the URL it dials and scopes each request by the wire
 * contract (`transport/gateway-profile.ts`).
 */
export class HermesGateway extends JsonRpcGatewayClient {
  /**
   * The close code of the last socket this client lost, when the server sent
   * one: 4401/4403 is a refused credential, none is a dropped connection. Read
   * after the close, so it outlives the socket.
   */
  lastCloseCode: number | undefined

  /** The profile this socket was minted for; none is the launch profile. */
  private profile: string | undefined

  constructor() {
    super({
      closedErrorMessage: 'Hermes gateway connection closed',
      connectErrorMessage: 'Could not connect to Hermes gateway',
      createRequestId: nextId => nextId,
      notConnectedErrorMessage: 'Hermes gateway is not connected',
      // The channel already answered -32603; surface the crash in devtools like the dial-failure sink.
      onRequestHandlerError: (error, request) =>
        console.error(`[gateway] server request handler crashed for ${request.method} (${request.id}):`, error),
      // The channel already answered -32601; note the missing registry in devtools.
      onUnhandledRequest: request =>
        console.warn(`[gateway] Hermes Desktop has no server-request registry for ${request.method} (${request.id})`),
      onSocketClose: event => {
        this.lastCloseCode = event.code
      },
      requestTimeoutMs: 30_000,
      socketFactory: openGatewaySocket
    })
  }

  override connect(wsUrl: string): Promise<void> {
    this.profile = socketProfile(wsUrl)

    return super.connect(wsUrl)
  }

  override request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<T> {
    return super.request<T>(method, profileScoped(method, params, this.profile), timeoutMs, signal)
  }
}
