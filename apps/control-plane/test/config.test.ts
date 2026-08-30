import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function productionEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: "https://opencode.example.invalid",
    DATABASE_KEY: randomBytes(32).toString("base64url"),
    SESSION_KEY: randomBytes(32).toString("base64url"),
    GRANT_SIGNING_PRIVATE_KEY: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    OIDC_ISSUER: "https://auth.example.invalid/application/o/opencode/",
    OIDC_CLIENT_ID: "opencode-client",
    OIDC_CLIENT_SECRET: "synthetic-client-secret",
    OIDC_REDIRECT_URI: "https://opencode.example.invalid/auth/callback",
  };
}

describe("production identity configuration", () => {
  it("accepts a dedicated OpenCode OIDC client", () => {
    expect(loadConfig(productionEnv()).oidc?.clientId).toBe("opencode-client");
  });

  it("rejects an incomplete OIDC client", () => {
    const env = productionEnv();
    delete env.OIDC_CLIENT_SECRET;
    expect(() => loadConfig(env)).toThrow(
      "OIDC configuration must be complete",
    );
  });

  it("rejects a non-loopback production listener", () => {
    expect(() => loadConfig({ ...productionEnv(), HOST: "0.0.0.0" })).toThrow(
      "loopback",
    );
  });
});
