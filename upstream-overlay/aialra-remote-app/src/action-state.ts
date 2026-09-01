export type ActionPhase =
  | "idle"
  | "preparing"
  | "running"
  | "success"
  | "failed"
  | "unknown";

export type RemoteErrorCategory =
  | "channel_acquire_timeout"
  | "upstream_timeout"
  | "authentication_failure"
  | "host_offline"
  | "boundary_rejected"
  | "cancelled"
  | "unknown_write_state";

export interface ActionState {
  phase: ActionPhase;
  category?: RemoteErrorCategory;
  requestId?: string;
  hostId?: string;
  sent?: boolean;
  retryable?: boolean;
  updatedAt: number;
}

export interface RelayErrorOptions {
  category: RemoteErrorCategory;
  requestId?: string;
  hostId?: string;
  sent?: boolean;
  retryable?: boolean;
  cause?: unknown;
}

export class RemoteFetchError extends Error {
  readonly category: RemoteErrorCategory;
  readonly requestId?: string;
  readonly hostId?: string;
  readonly sent: boolean;
  readonly retryable: boolean;

  constructor(message: string, options: RelayErrorOptions) {
    // The upstream health checker retries transport-like failures based on a
    // conservative message heuristic. Preserve the structured category for
    // the wrapper while marking only explicitly retryable relay failures as a
    // network error; boundary, auth and unknown-write errors must not retry.
    super(
      options.retryable === true
        ? `network relay failure: ${message}`
        : message,
      { cause: options.cause },
    );
    this.name = "RemoteFetchError";
    this.category = options.category;
    this.requestId = options.requestId;
    this.hostId = options.hostId;
    this.sent = options.sent ?? false;
    this.retryable = options.retryable ?? false;
  }
}

export interface RemoteRequestEventDetail {
  requestId: string;
  hostId: string;
  operation: "metadata" | "prompt" | "write" | "event" | "pty";
  phase:
    | "preparing"
    | "channel_ready"
    | "sent"
    | "response"
    | "failed"
    | "cancelled";
  category?: RemoteErrorCategory;
  sent: boolean;
}

export const REMOTE_REQUEST_EVENT = "aialra:remote-request";

export function operationFor(
  path: string,
  method: string,
): RemoteRequestEventDetail["operation"] {
  if (path.endsWith("/prompt")) return "prompt";
  if (path.endsWith("/event")) return "event";
  if (path.includes("/pty")) return "pty";
  if (method === "GET" || method === "HEAD") return "metadata";
  return "write";
}

export function dispatchRemoteRequestEvent(
  detail: RemoteRequestEventDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REMOTE_REQUEST_EVENT, { detail }));
}

export function actionStateFromEvent(
  detail: RemoteRequestEventDetail,
): ActionState {
  const phase: ActionPhase =
    detail.phase === "preparing" || detail.phase === "channel_ready"
      ? "preparing"
      : detail.phase === "sent"
        ? "running"
        : detail.phase === "response"
          ? "success"
          : detail.phase === "cancelled"
            ? "failed"
            : detail.category === "unknown_write_state"
              ? "unknown"
              : "failed";
  return {
    phase,
    category: detail.category,
    requestId: detail.requestId,
    hostId: detail.hostId,
    sent: detail.sent,
    retryable:
      phase === "failed" &&
      detail.category !== "authentication_failure" &&
      detail.category !== "boundary_rejected" &&
      detail.category !== "unknown_write_state",
    updatedAt: Date.now(),
  };
}
