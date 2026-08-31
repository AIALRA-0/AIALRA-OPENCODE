export interface HostDescriptor {
  hostId: string;
  displayName: string;
  mode: "vps" | "remote";
  state: "online" | "degraded" | "offline" | "unsupported";
  platform: "windows" | "linux";
  agentVersion: string;
  opencodeVersion: string | null;
  openapiSha256: string | null;
  upstreamCommit: string | null;
  capabilities: string[];
  lastSeenAt: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

function csrfToken(): string {
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("aialra_csrf="));
  if (!value) throw new Error("CSRF token is unavailable");
  return decodeURIComponent(value.slice("aialra_csrf=".length));
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.method && init.method !== "GET"
        ? { "x-csrf-token": csrfToken() }
        : {}),
      ...init?.headers,
    },
  });
  if (response.status === 401) {
    const destination = encodeURIComponent(
      location.pathname + location.search + location.hash,
    );
    location.assign(`/auth/login?returnTo=${destination}`);
    throw new Error("Authentication is required");
  }
  if (!response.ok)
    throw new Error(`control plane returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function bootstrap(): Promise<HostDescriptor[]> {
  await api<{ subject: string }>("/api/v1/me");
  const result = await api<{ hosts: HostDescriptor[] }>("/api/v1/hosts");
  return result.hosts;
}

export async function createPairingCode(
  displayName: string,
  mode: "vps" | "remote",
): Promise<PairingCode> {
  return api<PairingCode>("/api/v1/pairing-codes", {
    method: "POST",
    body: JSON.stringify({ displayName, mode }),
  });
}

export async function relayGrant(
  hostId: string,
  scopes: string[],
): Promise<{ token: string; expiresAt: string }> {
  return api<{ token: string; expiresAt: string }>("/api/v1/relay-grants", {
    method: "POST",
    body: JSON.stringify({ hostId, scopes, ttlSeconds: 300 }),
  });
}

export async function hostIdentity(hostId: string): Promise<string> {
  const result = await api<{ publicKeyPem: string }>(
    `/api/v1/hosts/${encodeURIComponent(hostId)}/identity`,
  );
  return result.publicKeyPem;
}

export { csrfToken };
