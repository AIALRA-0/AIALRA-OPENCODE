import type { HostDescriptor } from "./api";
import type { RemoteErrorCategory } from "./action-state";

export type WorkspaceRootStatus =
  | "idle"
  | "loading"
  | "ready"
  | "retrying"
  | "failed";

export interface WorkspaceRootState {
  phase: WorkspaceRootStatus;
  root?: string;
  verifiedAt?: number;
  generation: number;
  errorCategory?: RemoteErrorCategory;
  retryable?: boolean;
}

export type WorkspaceRootResult =
  | {
      ok: true;
      hostId: string;
      directory: string;
      verifiedAt: number;
    }
  | {
      ok: false;
      hostId: string;
      category: RemoteErrorCategory;
      retryable: boolean;
      requestId?: string;
    };

export interface HostViewModel extends HostDescriptor {
  workspaceLabel: string;
  workspaceRoot?: string;
  rootStatus: WorkspaceRootStatus;
  rootErrorCategory?: RemoteErrorCategory;
  rootRetryable?: boolean;
  expanded: boolean;
}

export interface WorkspaceState {
  root?: string;
  rootStatus: WorkspaceRootStatus;
  rootState?: WorkspaceRootState;
  lastRoute?: string;
  expanded: boolean;
}

export type WorkspaceStateByHost = Record<string, WorkspaceState>;

export interface SessionKey {
  hostId: string;
  upstreamSessionId: string;
}

export type PromptSubmissionPhase =
  | "draft"
  | "preparing"
  | "sending"
  | "submitted"
  | "failed"
  | "unknown";

export interface PromptSubmissionState {
  phase: PromptSubmissionPhase;
  session?: SessionKey;
  requestId?: string;
  errorCategory?: string;
  requiresConfirmation?: boolean;
}

export function encodeWorkspaceDirectory(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
    "",
  );
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function workspaceSessionRoute(root: string): string {
  return `/${encodeWorkspaceDirectory(root)}/session`;
}

export function hostWorkspaceLabel(host: HostDescriptor): string {
  return host.mode === "vps" ? "VPS 工作区" : "远程工作区";
}

export function workspaceRootErrorMessage(
  category: RemoteErrorCategory,
): string {
  switch (category) {
    case "channel_acquire_timeout":
      return "连接主机超时，可在管理工作区中重试";
    case "upstream_timeout":
      return "主机响应超时，可在管理工作区中重试";
    case "authentication_failure":
      return "主机认证失败，请在管理工作区检查登记状态";
    case "host_offline":
      return "主机当前离线，可在管理工作区重试";
    case "boundary_rejected":
      return "工作区边界拒绝了目录验证";
    case "cancelled":
      return "目录验证已取消";
    case "unknown_write_state":
      return "目录验证状态未知，请在管理工作区重试";
  }
}
