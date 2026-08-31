import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {
  AuthService,
  canonicalLoginLocation,
  requestOrigin,
  safeReturnPath,
} from "../src/auth.js";
import type { AppConfig } from "../src/config.js";

describe("identity redirects", () => {
  const origin = new URL("https://kimi.example.invalid");

  it("keeps same-origin paths", () => {
    expect(safeReturnPath("/session?elevated=1#terminal", origin)).toBe(
      "/session?elevated=1#terminal",
    );
  });

  it.each([
    "https://attacker.invalid",
    "//attacker.invalid",
    "/\\attacker.invalid",
    "/safe\r\nLocation: https://attacker.invalid",
  ])("rejects external or ambiguous return target %s", (target) => {
    expect(safeReturnPath(target, origin)).toBe("/");
  });

  it("reads the forwarded request origin without accepting userinfo", () => {
    expect(
      requestOrigin({
        protocol: "https",
        headers: { host: "kimi.example.invalid" },
      } as never),
    ).toBe("https://kimi.example.invalid");
    expect(
      requestOrigin({
        protocol: "https",
        headers: { host: "attacker.invalid@kimi.example.invalid" },
      } as never),
    ).toBeNull();
  });

  it("encodes a canonical login location without changing the origin", () => {
    expect(canonicalLoginLocation(origin, "/session?tab=terminal#output")).toBe(
      "https://kimi.example.invalid/auth/login?returnTo=%2Fsession%3Ftab%3Dterminal%23output",
    );
  });

  it("redirects a canary login and callback to the canonical origin", async () => {
    const app = Fastify({ trustProxy: true });
    await app.register(cookie);
    const auth = new AuthService({
      publicOrigin: origin,
      nodeEnv: "production",
      oidc: null,
    } as AppConfig);
    await auth.registerRoutes(app);

    const login = await app.inject({
      method: "GET",
      url: "https://canary.example.invalid/auth/login?returnTo=%2Fsession",
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe(
      "https://kimi.example.invalid/auth/login?returnTo=%2Fsession",
    );

    const callback = await app.inject({
      method: "GET",
      url: "https://canary.example.invalid/auth/callback?code=stale&state=stale",
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      "https://kimi.example.invalid/auth/login?returnTo=%2F",
    );
    await app.close();
  });

  it("returns a controlled expiration error on the canonical callback", async () => {
    const app = Fastify({ trustProxy: true });
    await app.register(cookie);
    const auth = new AuthService({
      publicOrigin: origin,
      nodeEnv: "production",
      oidc: {
        issuer: new URL("https://auth.example.invalid/application/o/opencode/"),
        clientId: "opencode-client",
        clientSecret: "synthetic-client-secret",
        redirectUri: new URL("https://kimi.example.invalid/auth/callback"),
        ownerGroup: "aialra-opencode-owner",
      },
    } as AppConfig);
    await auth.registerRoutes(app);

    const callback = await app.inject({
      method: "GET",
      url: "https://kimi.example.invalid/auth/callback?code=stale&state=stale",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.json()).toEqual({ error: "oidc_transaction_expired" });
    await app.close();
  });
});
