import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HostDescriptor,
  HostMode,
  HostState,
  SessionCacheItem,
} from "@aialra-opencode/protocol";
import { FieldCipher, stableHash } from "./crypto.js";

interface HostRow {
  host_id: string;
  display_name: string;
  mode: HostMode;
  platform: "windows" | "linux";
  public_key: string;
  state: HostState;
  agent_version: string;
  opencode_version: string | null;
  openapi_sha256: string | null;
  upstream_commit: string | null;
  capabilities_json: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface SessionRow {
  host_id: string;
  upstream_session_id: string;
  session_label_enc: string;
  workspace_alias_enc: string;
  updated_at: string;
  state: SessionCacheItem["state"];
}

export class ControlPlaneDatabase {
  readonly raw: DatabaseSync;
  private readonly cipher: FieldCipher;
  private readonly hashKey: Uint8Array;

  constructor(path: string, encryptionKey: Uint8Array) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.cipher = new FieldCipher(encryptionKey);
    this.hashKey = encryptionKey;
    this.raw.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;",
    );
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('vps', 'remote')),
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS hosts (
        host_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('vps', 'remote')),
        platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux')),
        public_key TEXT NOT NULL,
        state TEXT NOT NULL,
        agent_version TEXT NOT NULL,
        opencode_version TEXT,
        openapi_sha256 TEXT,
        upstream_commit TEXT,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_seen_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_cache (
        host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
        upstream_session_id TEXT NOT NULL,
        session_label_enc TEXT NOT NULL,
        workspace_alias_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (host_id, upstream_session_id)
      );
      CREATE TABLE IF NOT EXISTS replay_nonces (
        nonce_hash TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        subject TEXT NOT NULL,
        host_id TEXT,
        action_category TEXT NOT NULL,
        outcome TEXT NOT NULL,
        request_id TEXT NOT NULL
      );
    `);
  }

  storePairingCode(
    code: string,
    displayName: string,
    mode: HostMode,
    expiresAt: Date,
  ): void {
    this.raw
      .prepare(
        "INSERT INTO pairing_codes(code_hash, display_name, mode, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        stableHash(code, this.hashKey),
        displayName,
        mode,
        expiresAt.toISOString(),
      );
  }

  consumePairingCode(
    code: string,
  ): { displayName: string; mode: HostMode } | null {
    const codeHash = stableHash(code, this.hashKey);
    const row = this.raw
      .prepare(
        "SELECT display_name, mode, expires_at, used_at FROM pairing_codes WHERE code_hash = ?",
      )
      .get(codeHash) as
      | {
          display_name: string;
          mode: HostMode;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;
    if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now())
      return null;
    const result = this.raw
      .prepare(
        "UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
      )
      .run(new Date().toISOString(), codeHash);
    return result.changes === 1
      ? { displayName: row.display_name, mode: row.mode }
      : null;
  }

  registerHost(input: {
    hostId: string;
    displayName: string;
    mode: HostMode;
    platform: "windows" | "linux";
    publicKey: string;
    agentVersion: string;
  }): void {
    this.raw
      .prepare(
        `
      INSERT INTO hosts(
        host_id, display_name, mode, platform, public_key, state, agent_version,
        opencode_version, openapi_sha256, upstream_commit, capabilities_json,
        last_seen_at, revoked_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'offline', ?, NULL, NULL, NULL, '[]', NULL, NULL, ?)
    `,
      )
      .run(
        input.hostId,
        input.displayName,
        input.mode,
        input.platform,
        input.publicKey,
        input.agentVersion,
        new Date().toISOString(),
      );
  }

  getHostIdentity(
    hostId: string,
  ): { publicKey: string; revoked: boolean } | null {
    const row = this.raw
      .prepare("SELECT public_key, revoked_at FROM hosts WHERE host_id = ?")
      .get(hostId) as
      | { public_key: string; revoked_at: string | null }
      | undefined;
    return row
      ? { publicKey: row.public_key, revoked: row.revoked_at !== null }
      : null;
  }

  updateHostStatus(input: {
    hostId: string;
    state: HostState;
    agentVersion: string;
    opencodeVersion: string;
    openapiSha256: string;
    upstreamCommit?: string | undefined;
    capabilities?: string[] | undefined;
  }): void {
    this.raw
      .prepare(
        `
      UPDATE hosts SET state = ?, agent_version = ?, opencode_version = ?, openapi_sha256 = ?,
        upstream_commit = COALESCE(?, upstream_commit), capabilities_json = ?, last_seen_at = ?
      WHERE host_id = ? AND revoked_at IS NULL
    `,
      )
      .run(
        input.state,
        input.agentVersion,
        input.opencodeVersion,
        input.openapiSha256,
        input.upstreamCommit ?? null,
        JSON.stringify(input.capabilities ?? []),
        new Date().toISOString(),
        input.hostId,
      );
  }

  markHostOffline(hostId: string): void {
    this.raw
      .prepare(
        "UPDATE hosts SET state = 'offline' WHERE host_id = ? AND revoked_at IS NULL",
      )
      .run(hostId);
  }

  markAllHostsOffline(): void {
    this.raw
      .prepare("UPDATE hosts SET state = 'offline' WHERE revoked_at IS NULL")
      .run();
  }

  revokeHost(hostId: string): boolean {
    const result = this.raw
      .prepare(
        "UPDATE hosts SET state = 'offline', revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), hostId);
    return result.changes === 1;
  }

  listHosts(): HostDescriptor[] {
    const rows = this.raw
      .prepare(
        "SELECT * FROM hosts WHERE revoked_at IS NULL ORDER BY display_name COLLATE NOCASE",
      )
      .all() as unknown as HostRow[];
    return rows.map((row) => ({
      hostId: row.host_id,
      displayName: row.display_name,
      mode: row.mode,
      state: row.state,
      platform: row.platform,
      agentVersion: row.agent_version,
      opencodeVersion: row.opencode_version,
      openapiSha256: row.openapi_sha256,
      upstreamCommit: row.upstream_commit,
      lastSeenAt: row.last_seen_at,
      capabilities: JSON.parse(row.capabilities_json) as string[],
    }));
  }

  replaceSessionCache(hostId: string, sessions: SessionCacheItem[]): void {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.raw
        .prepare("DELETE FROM session_cache WHERE host_id = ?")
        .run(hostId);
      const insert = this.raw.prepare(`
        INSERT INTO session_cache(
          host_id, upstream_session_id, session_label_enc, workspace_alias_enc, updated_at, state
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const session of sessions) {
        if (session.hostId !== hostId)
          throw new Error("cross-host cache update rejected");
        const context = `${hostId}:${session.upstreamSessionId}`;
        insert.run(
          hostId,
          session.upstreamSessionId,
          this.cipher.encrypt(session.sessionLabel, `${context}:session`),
          this.cipher.encrypt(session.workspaceAlias, `${context}:workspace`),
          session.updatedAt,
          session.state,
        );
      }
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  getSessionCache(hostId: string): SessionCacheItem[] {
    const rows = this.raw
      .prepare(
        "SELECT * FROM session_cache WHERE host_id = ? ORDER BY updated_at DESC LIMIT 10000",
      )
      .all(hostId) as unknown as SessionRow[];
    return rows.map((row) => {
      const context = `${row.host_id}:${row.upstream_session_id}`;
      return {
        hostId: row.host_id,
        upstreamSessionId: row.upstream_session_id,
        sessionLabel: this.cipher.decrypt(
          row.session_label_enc,
          `${context}:session`,
        ),
        workspaceAlias: this.cipher.decrypt(
          row.workspace_alias_enc,
          `${context}:workspace`,
        ),
        updatedAt: row.updated_at,
        state: row.state,
      };
    });
  }

  consumeNonce(nonce: string, expiresAt: Date): boolean {
    this.raw
      .prepare("DELETE FROM replay_nonces WHERE expires_at <= ?")
      .run(new Date().toISOString());
    try {
      this.raw
        .prepare(
          "INSERT INTO replay_nonces(nonce_hash, expires_at) VALUES (?, ?)",
        )
        .run(stableHash(nonce, this.hashKey), expiresAt.toISOString());
      return true;
    } catch {
      return false;
    }
  }

  audit(input: {
    occurredAt?: string;
    subject: string;
    hostId?: string;
    category: string;
    outcome: string;
    requestId: string;
  }): void {
    this.raw
      .prepare(
        `
      INSERT INTO audit_events(occurred_at, subject, host_id, action_category, outcome, request_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.occurredAt ?? new Date().toISOString(),
        input.subject,
        input.hostId ?? null,
        input.category,
        input.outcome,
        input.requestId,
      );
  }
}
