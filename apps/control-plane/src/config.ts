import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PUBLIC_ORIGIN: z.string().url().default("http://127.0.0.1:8787"),
  DATABASE_PATH: z.string().default("./data/control-plane.sqlite"),
  DATABASE_KEY: z.string().optional(),
  DATABASE_KEY_FILE: z.string().optional(),
  SESSION_KEY: z.string().optional(),
  SESSION_KEY_FILE: z.string().optional(),
  GRANT_SIGNING_PRIVATE_KEY: z.string().optional(),
  GRANT_SIGNING_PRIVATE_KEY_FILE: z.string().optional(),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_CLIENT_SECRET_FILE: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_OWNER_GROUP: z.string().default("aialra-opencode-owner"),
  DEV_AUTH_BYPASS: z.enum(["0", "1"]).default("0"),
  WEB_DIST_PATH: z.string().default("../web/dist"),
  TRUST_PROXY: z.enum(["0", "1"]).default("0"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicOrigin: URL;
  databasePath: string;
  databaseKey: Uint8Array;
  sessionKey: Uint8Array;
  grantSigningPrivateKey: string;
  oidc: null | {
    issuer: URL;
    clientId: string;
    clientSecret: string;
    redirectUri: URL;
    ownerGroup: string;
  };
  devAuthBypass: boolean;
  webDistPath: string;
  trustProxy: boolean;
}

function decodeKey(
  name: string,
  value: string | undefined,
): Uint8Array | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32)
    throw new Error(`${name} must be 32 bytes encoded as base64url`);
  return key;
}

function secretValue(
  name: string,
  inline: string | undefined,
  file: string | undefined,
): string | undefined {
  if (inline && file)
    throw new Error(`${name} and ${name}_FILE cannot both be set`);
  if (!file) return inline;
  try {
    return readFileSync(file, "utf8").trim();
  } catch (error) {
    throw new Error(`Unable to read ${name}_FILE`, { cause: error });
  }
}

function ephemeralSigningKey(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = ConfigSchema.parse(input);
  const isProduction = env.NODE_ENV === "production";
  const devAuthBypass = env.DEV_AUTH_BYPASS === "1";
  const databaseKeyValue = secretValue(
    "DATABASE_KEY",
    env.DATABASE_KEY,
    env.DATABASE_KEY_FILE,
  );
  const sessionKeyValue = secretValue(
    "SESSION_KEY",
    env.SESSION_KEY,
    env.SESSION_KEY_FILE,
  );
  const grantSigningKeyValue = secretValue(
    "GRANT_SIGNING_PRIVATE_KEY",
    env.GRANT_SIGNING_PRIVATE_KEY,
    env.GRANT_SIGNING_PRIVATE_KEY_FILE,
  );
  const oidcClientSecret = secretValue(
    "OIDC_CLIENT_SECRET",
    env.OIDC_CLIENT_SECRET,
    env.OIDC_CLIENT_SECRET_FILE,
  );
  const databaseKey =
    decodeKey("DATABASE_KEY", databaseKeyValue) ?? randomBytes(32);
  const sessionKey =
    decodeKey("SESSION_KEY", sessionKeyValue) ?? randomBytes(32);
  const grantSigningPrivateKey = grantSigningKeyValue ?? ephemeralSigningKey();

  if (isProduction) {
    if (!databaseKeyValue || !sessionKeyValue || !grantSigningKeyValue) {
      throw new Error(
        "Production requires DATABASE_KEY, SESSION_KEY, and GRANT_SIGNING_PRIVATE_KEY",
      );
    }
    if (devAuthBypass)
      throw new Error("DEV_AUTH_BYPASS is forbidden in production");
    if (env.HOST !== "127.0.0.1" && env.HOST !== "::1") {
      throw new Error(
        "Production control plane must bind to a loopback address",
      );
    }
    if (!env.PUBLIC_ORIGIN.startsWith("https://")) {
      throw new Error("Production PUBLIC_ORIGIN must use HTTPS");
    }
  }

  const oidcValues = [
    env.OIDC_ISSUER,
    env.OIDC_CLIENT_ID,
    oidcClientSecret,
    env.OIDC_REDIRECT_URI,
  ];
  const hasPartialOidc = oidcValues.some(Boolean) && !oidcValues.every(Boolean);
  if (hasPartialOidc) throw new Error("OIDC configuration must be complete");
  if (isProduction && !oidcValues.every(Boolean))
    throw new Error("Production requires OIDC");
  if (isProduction && oidcValues.every(Boolean)) {
    const redirectUri = new URL(env.OIDC_REDIRECT_URI!);
    const publicOrigin = new URL(env.PUBLIC_ORIGIN);
    if (
      redirectUri.origin !== publicOrigin.origin ||
      redirectUri.pathname !== "/auth/callback" ||
      redirectUri.search ||
      redirectUri.hash
    ) {
      throw new Error(
        "Production OIDC_REDIRECT_URI must match PUBLIC_ORIGIN/auth/callback",
      );
    }
  }
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    publicOrigin: new URL(env.PUBLIC_ORIGIN),
    databasePath: resolve(env.DATABASE_PATH),
    databaseKey,
    sessionKey,
    grantSigningPrivateKey,
    oidc: oidcValues.every(Boolean)
      ? {
          issuer: new URL(env.OIDC_ISSUER!),
          clientId: env.OIDC_CLIENT_ID!,
          clientSecret: oidcClientSecret!,
          redirectUri: new URL(env.OIDC_REDIRECT_URI!),
          ownerGroup: env.OIDC_OWNER_GROUP,
        }
      : null,
    devAuthBypass,
    webDistPath: resolve(env.WEB_DIST_PATH),
    trustProxy: env.TRUST_PROXY === "1",
  };
}
