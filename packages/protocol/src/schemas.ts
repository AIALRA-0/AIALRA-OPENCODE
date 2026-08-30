import { z } from "zod";
import { RELAY_OPERATIONS } from "./operations.js";

export const HOST_MODES = ["vps", "remote"] as const;
export const HOST_STATES = [
  "online",
  "degraded",
  "offline",
  "unsupported",
] as const;
export const CHANNEL_KINDS = [
  "opencode-http",
  "opencode-event",
  "opencode-pty",
] as const;
export const ROUTE_CATEGORIES = ["read", "write", "event", "pty"] as const;
export const STREAM_TYPES = ["none", "sse", "websocket"] as const;

export const HostModeSchema = z.enum(HOST_MODES);
export const HostStateSchema = z.enum(HOST_STATES);
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export const RouteCategorySchema = z.enum(ROUTE_CATEGORIES);
export const StreamTypeSchema = z.enum(STREAM_TYPES);

export type HostMode = z.infer<typeof HostModeSchema>;
export type HostState = z.infer<typeof HostStateSchema>;
export type ChannelKind = z.infer<typeof ChannelKindSchema>;
export type RouteCategory = z.infer<typeof RouteCategorySchema>;
export type StreamType = z.infer<typeof StreamTypeSchema>;

export const RouteCapabilitySchema = z.object({
  methods: z
    .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]))
    .min(1),
  pathTemplate: z.string().startsWith("/").max(512),
  category: RouteCategorySchema,
  maxBodyBytes: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1024 * 1024),
  stream: StreamTypeSchema,
});

export const RouteCapabilityManifestSchema = z.object({
  version: z.literal(1),
  upstreamVersion: z.string().min(1),
  upstreamCommit: z.string().regex(/^[0-9a-f]{7,64}$/),
  sourceOpenapiSha256: z.string().regex(/^[0-9a-f]{64}$/),
  openapiSha256: z.string().regex(/^[0-9a-f]{64}$/),
  generatedAt: z.string().datetime(),
  routes: z.array(RouteCapabilitySchema).min(1),
});

export type RouteCapability = z.infer<typeof RouteCapabilitySchema>;
export type RouteCapabilityManifest = z.infer<
  typeof RouteCapabilityManifestSchema
>;

export const HostDescriptorSchema = z.object({
  hostId: z.string().min(8).max(128),
  displayName: z.string().min(1).max(120),
  mode: HostModeSchema,
  state: HostStateSchema,
  platform: z.enum(["windows", "linux"]),
  agentVersion: z.string().min(1),
  opencodeVersion: z.string().nullable(),
  openapiSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  upstreamCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  capabilities: z.array(z.string().min(1).max(80)).max(64),
  lastSeenAt: z.string().datetime().nullable(),
});

export type HostDescriptor = z.infer<typeof HostDescriptorSchema>;

export const HostSessionRefSchema = z.object({
  hostId: z.string().min(8).max(128),
  upstreamSessionId: z.string().min(1).max(512),
});

export type HostSessionRef = z.infer<typeof HostSessionRefSchema>;

export const SessionCacheItemSchema = z.object({
  hostId: z.string().min(8).max(128),
  upstreamSessionId: z.string().min(1).max(512),
  sessionLabel: z.string().regex(/^session-[0-9a-f]{12}$/),
  workspaceAlias: z.string().regex(/^workspace-[0-9a-f]{12}$/),
  updatedAt: z.string().datetime(),
  state: z.enum(["idle", "running", "waiting", "error"]),
});

export type SessionCacheItem = z.infer<typeof SessionCacheItemSchema>;

export const CapabilityGrantSchema = z.object({
  grantId: z.string().uuid(),
  subject: z.string().min(1),
  hostId: z.string().min(8).max(128),
  scopes: z.array(z.enum(RELAY_OPERATIONS)).min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.string().min(22).max(128),
});

export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const EncryptedChannelFrameSchema = z.object({
  channelId: z.string().uuid(),
  channel: ChannelKindSchema,
  sequence: z.number().int().nonnegative(),
  nonce: z.string().min(32).max(64),
  ciphertext: z.string().min(1),
  tag: z.string().min(16).max(64),
});

export type EncryptedChannelFrame = z.infer<typeof EncryptedChannelFrameSchema>;

const HeadersSchema = z
  .record(z.string(), z.string().max(32_768))
  .refine((headers) => Object.keys(headers).length <= 64, "too many headers");

export const RelayHttpRequestSchema = z.object({
  type: z.literal("relay.http.request"),
  requestId: z.string().uuid(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  path: z.string().startsWith("/").max(2_048),
  query: z.string().max(8_192),
  headers: HeadersSchema,
  bodyBase64: z
    .string()
    .max(24 * 1024 * 1024)
    .nullable(),
});

export const RelayHttpResponseStartSchema = z.object({
  type: z.literal("relay.http.response.start"),
  requestId: z.string().uuid(),
  status: z.number().int().min(100).max(599),
  headers: HeadersSchema,
});

export const RelayHttpChunkSchema = z.object({
  type: z.literal("relay.http.chunk"),
  requestId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  bodyBase64: z.string().max(2 * 1024 * 1024),
});

export const RelayHttpEndSchema = z.object({
  type: z.literal("relay.http.end"),
  requestId: z.string().uuid(),
  errorCode: z.string().max(80).nullable(),
});

export const RelayHttpCancelSchema = z.object({
  type: z.literal("relay.http.cancel"),
  requestId: z.string().uuid(),
});

export const RelaySocketOpenSchema = z.object({
  type: z.literal("relay.socket.open"),
  socketId: z.string().uuid(),
  path: z.string().startsWith("/").max(2_048),
  query: z.string().max(8_192),
  protocols: z.array(z.string().max(128)).max(8),
});

export const RelaySocketDataSchema = z.object({
  type: z.literal("relay.socket.data"),
  socketId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  binary: z.boolean(),
  dataBase64: z.string().max(2 * 1024 * 1024),
});

export const RelaySocketCloseSchema = z.object({
  type: z.literal("relay.socket.close"),
  socketId: z.string().uuid(),
  code: z.number().int().min(1000).max(4999),
  reason: z.string().max(123),
});

export const RelayPayloadSchema = z.discriminatedUnion("type", [
  RelayHttpRequestSchema,
  RelayHttpResponseStartSchema,
  RelayHttpChunkSchema,
  RelayHttpEndSchema,
  RelayHttpCancelSchema,
  RelaySocketOpenSchema,
  RelaySocketDataSchema,
  RelaySocketCloseSchema,
]);

export type RelayPayload = z.infer<typeof RelayPayloadSchema>;
export type RelayHttpRequest = z.infer<typeof RelayHttpRequestSchema>;
export type RelayHttpResponseStart = z.infer<
  typeof RelayHttpResponseStartSchema
>;
export type RelayHttpChunk = z.infer<typeof RelayHttpChunkSchema>;
export type RelayHttpEnd = z.infer<typeof RelayHttpEndSchema>;
export type RelayHttpCancel = z.infer<typeof RelayHttpCancelSchema>;
export type RelaySocketOpen = z.infer<typeof RelaySocketOpenSchema>;
export type RelaySocketData = z.infer<typeof RelaySocketDataSchema>;
export type RelaySocketClose = z.infer<typeof RelaySocketCloseSchema>;

export const AgentEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.enroll"),
    requestId: z.string().uuid(),
    code: z.string().regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
    publicKey: z.string().min(40).max(256),
    displayName: z.string().min(1).max(120),
    mode: HostModeSchema,
    platform: z.enum(["windows", "linux"]),
    agentVersion: z.string().min(1),
  }),
  z.object({
    type: z.literal("agent.hello"),
    requestId: z.string().uuid(),
    hostId: z.string().min(8).max(128),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(22).max(128),
    signature: z.string().min(64).max(512),
    agentVersion: z.string().min(1),
    opencodeVersion: z.string().min(1),
    openapiSha256: z.string().regex(/^[0-9a-f]{64}$/),
    upstreamCommit: z.string().regex(/^[0-9a-f]{7,64}$/),
    capabilities: z.array(z.string().min(1).max(80)).max(64),
  }),
  z.object({
    type: z.literal("agent.heartbeat"),
    hostId: z.string().min(8).max(128),
    sequence: z.number().int().nonnegative(),
    state: z.enum(["online", "degraded"]),
    opencodeVersion: z.string().min(1),
    openapiSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    type: z.literal("agent.session-cache"),
    hostId: z.string().min(8).max(128),
    generatedAt: z.string().datetime(),
    sessions: z.array(SessionCacheItemSchema).max(10_000),
  }),
  z.object({
    type: z.literal("agent.audit"),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    requestId: z.string().uuid(),
    category: z.enum(RELAY_OPERATIONS),
    outcome: z.enum(["started", "succeeded", "failed", "cancelled"]),
    occurredAt: z.string().datetime(),
  }),
  z.object({
    type: z.literal("agent.channel.accept"),
    requestId: z.string().uuid(),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    agentEphemeralKey: z.string().min(40).max(128),
    signature: z.string().min(64).max(512),
  }),
  z.object({
    type: z.literal("agent.frame"),
    hostId: z.string().min(8).max(128),
    frame: EncryptedChannelFrameSchema,
  }),
  z.object({
    type: z.literal("agent.error"),
    requestId: z.string().uuid().nullable(),
    hostId: z.string().min(8).max(128).nullable(),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }),
]);

export type AgentEnvelope = z.infer<typeof AgentEnvelopeSchema>;

export const BrowserEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("browser.channel.open"),
    requestId: z.string().uuid(),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    channel: ChannelKindSchema,
    browserEphemeralKey: z.string().min(40).max(128),
    grant: z.string().min(64),
  }),
  z.object({
    type: z.literal("browser.frame"),
    hostId: z.string().min(8).max(128),
    grant: z.string().min(64),
    frame: EncryptedChannelFrameSchema,
  }),
  z.object({
    type: z.literal("browser.channel.close"),
    hostId: z.string().min(8).max(128),
    channelId: z.string().uuid(),
    reason: z.enum(["user", "disconnect", "expired"]),
  }),
]);

export type BrowserEnvelope = z.infer<typeof BrowserEnvelopeSchema>;
