import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const root =
  process.env.AIALRA_OPENCODE_E2E_ROOT ??
  join(tmpdir(), "AIALRA-OPENCODE-e2e-current");
mkdirSync(root, { recursive: true });

function persistentFixture(name: string, generate: () => string): string {
  const path = join(root, name);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const value = generate();
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return value;
}

const databaseKey = persistentFixture("database.key", () =>
  randomBytes(32).toString("base64url"),
);
const sessionKey = persistentFixture("session.key", () =>
  randomBytes(32).toString("base64url"),
);
const grantSigningKey = persistentFixture("grant-signing.pem", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" }).toString();
});

const config = loadConfig({
  ...process.env,
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: process.env.AIALRA_OPENCODE_E2E_PORT ?? "8787",
  PUBLIC_ORIGIN: `http://127.0.0.1:${process.env.AIALRA_OPENCODE_E2E_PORT ?? "8787"}`,
  DATABASE_PATH: join(root, "control-plane.sqlite"),
  DATABASE_KEY: databaseKey,
  SESSION_KEY: sessionKey,
  GRANT_SIGNING_PRIVATE_KEY: grantSigningKey,
  DEV_AUTH_BYPASS: "1",
  WEB_DIST_PATH: fileURLToPath(new URL("../../web/dist", import.meta.url)),
});

const services = await createApp(config);

const shutdown = async () => {
  await services.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.stdin.resume();
process.stdin.once("end", () => void shutdown());

try {
  await services.app.listen({ host: config.host, port: config.port });
} catch (error) {
  services.app.log.error(error);
  await services.close();
  process.exit(1);
}
