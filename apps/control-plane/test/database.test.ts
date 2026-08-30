import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDatabase } from "../src/database.js";

const databases: ControlPlaneDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): { database: ControlPlaneDatabase; path: string } {
  const path = join(
    mkdtempSync(join(tmpdir(), "aialra-opencode-db-")),
    "control.sqlite",
  );
  const database = new ControlPlaneDatabase(path, randomBytes(32));
  databases.push(database);
  return { database, path };
}

describe("control-plane database", () => {
  it("consumes pairing codes exactly once", () => {
    const { database } = createDatabase();
    database.storePairingCode(
      "ABCD-EFGH",
      "Desktop",
      "remote",
      new Date(Date.now() + 60_000),
    );
    expect(database.consumePairingCode("ABCD-EFGH")).toEqual({
      displayName: "Desktop",
      mode: "remote",
    });
    expect(database.consumePairingCode("ABCD-EFGH")).toBeNull();
  });

  it("encrypts anonymous session and workspace labels at rest", () => {
    const { database, path } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });
    database.replaceSessionCache("host-alpha", [
      {
        hostId: "host-alpha",
        upstreamSessionId: "session-one",
        sessionLabel: "session-a1b2c3d4e5f6",
        workspaceAlias: "workspace-a1b2c3d4e5f6",
        updatedAt: new Date().toISOString(),
        state: "idle",
      },
    ]);
    expect(database.getSessionCache("host-alpha")[0]?.sessionLabel).toBe(
      "session-a1b2c3d4e5f6",
    );
    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from("session-a1b2c3d4e5f6"))).toBe(false);
    expect(bytes.includes(Buffer.from("workspace-a1b2c3d4e5f6"))).toBe(false);
  });

  it("rejects cross-host cache entries", () => {
    const { database } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });
    expect(() =>
      database.replaceSessionCache("host-alpha", [
        {
          hostId: "host-bravo",
          upstreamSessionId: "session-one",
          sessionLabel: "session-a1b2c3d4e5f6",
          workspaceAlias: "workspace-a1b2c3d4e5f6",
          updatedAt: new Date().toISOString(),
          state: "idle",
        },
      ]),
    ).toThrow("cross-host");
  });

  it("revokes a host identity exactly once", () => {
    const { database } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });

    expect(database.revokeHost("host-alpha")).toBe(true);
    expect(database.revokeHost("host-alpha")).toBe(false);
    expect(database.getHostIdentity("host-alpha")?.revoked).toBe(true);
    expect(database.listHosts()).toEqual([]);
  });

  it("marks persisted hosts offline before agents reconnect after a restart", () => {
    const { database } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });
    database.updateHostStatus({
      hostId: "host-alpha",
      state: "online",
      agentVersion: "0.1.0",
      opencodeVersion: "1.18.25",
      openapiSha256: "a".repeat(64),
      upstreamCommit: "b".repeat(40),
      capabilities: ["http"],
    });

    database.markAllHostsOffline();

    expect(database.listHosts()[0]?.state).toBe("offline");
  });
});
