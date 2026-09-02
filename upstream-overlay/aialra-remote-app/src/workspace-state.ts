import type { HostDescriptor } from "./api";

export type WorkspaceRootStatus = "idle" | "loading" | "ready" | "failed";

export interface HostViewModel extends HostDescriptor {
  workspaceLabel: string;
  workspaceRoot?: string;
  rootStatus: WorkspaceRootStatus;
  expanded: boolean;
}

export interface WorkspaceState {
  root?: string;
  rootStatus: WorkspaceRootStatus;
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
