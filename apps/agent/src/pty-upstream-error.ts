export interface PtyUpstreamClose {
  code: 1011 | 4403 | 4404 | 4410;
  reason: string;
}

export function ptyUpstreamClose(error: unknown): PtyUpstreamClose {
  const message = error instanceof Error ? error.message : "";
  const status = /^Unexpected server response: (\d{3})$/.exec(message)?.[1];
  if (status === "403")
    return { code: 4403, reason: "PTY authorization expired" };
  if (status === "404") return { code: 4404, reason: "PTY session not found" };
  if (/opening handshake has timed out/i.test(message))
    return { code: 4410, reason: "OpenCode PTY handshake timed out" };
  return { code: 1011, reason: "OpenCode PTY connection failed" };
}
