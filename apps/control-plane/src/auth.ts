import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EncryptJWT, SignJWT, jwtDecrypt, jwtVerify } from "jose";
import * as oidc from "openid-client";
import type { AppConfig } from "./config.js";

export const SESSION_COOKIE = "aialra_session";
const OIDC_COOKIE = "aialra_oidc";
export const CSRF_COOKIE = "aialra_csrf";

export interface Principal {
  subject: string;
  displayName: string;
  groups: string[];
}

interface OidcTransaction {
  state: string;
  verifier: string;
  returnTo: string;
}

export function safeReturnPath(value: string, publicOrigin: URL): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/u.test(value)
  ) {
    return "/";
  }
  try {
    const target = new URL(value, publicOrigin);
    return target.origin === publicOrigin.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : "/";
  } catch {
    return "/";
  }
}

export class AuthService {
  private discovery: Promise<oidc.Configuration> | null = null;

  constructor(private readonly config: AppConfig) {}

  async sessionFromToken(token: string | undefined): Promise<Principal | null> {
    if (this.config.devAuthBypass && this.config.nodeEnv !== "production") {
      return {
        subject: "development-owner",
        displayName: "Development owner",
        groups: ["owner"],
      };
    }
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.config.sessionKey, {
        algorithms: ["HS256"],
        audience: "aialra-opencode",
        issuer: this.config.publicOrigin.origin,
      });
      const groups = Array.isArray(payload.groups)
        ? payload.groups.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      if (typeof payload.sub !== "string" || typeof payload.name !== "string")
        return null;
      return { subject: payload.sub, displayName: payload.name, groups };
    } catch {
      return null;
    }
  }

  async principal(request: FastifyRequest): Promise<Principal | null> {
    return this.sessionFromToken(request.cookies[SESSION_COOKIE]);
  }

  async requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Principal | null> {
    const principal = await this.principal(request);
    if (!principal) {
      await reply.code(401).send({ error: "authentication_required" });
      return null;
    }
    if (
      this.config.oidc &&
      !principal.groups.includes(this.config.oidc.ownerGroup) &&
      principal.subject !== "development-owner"
    ) {
      await reply.code(403).send({ error: "owner_group_required" });
      return null;
    }
    return principal;
  }

  verifyCsrf(request: FastifyRequest, reply: FastifyReply): boolean {
    const expectedOrigin = this.config.publicOrigin.origin;
    const origin = request.headers.origin;
    const token = request.headers["x-csrf-token"];
    const cookie = request.cookies[CSRF_COOKIE];
    if (
      origin !== expectedOrigin ||
      typeof token !== "string" ||
      !cookie ||
      token !== cookie
    ) {
      void reply.code(403).send({ error: "csrf_validation_failed" });
      return false;
    }
    return true;
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    app.get("/auth/login", async (request, reply) => {
      if (this.config.devAuthBypass && this.config.nodeEnv !== "production") {
        return reply.redirect("/");
      }
      if (!this.config.oidc)
        return reply.code(503).send({ error: "oidc_not_configured" });
      const provider = await this.provider();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const returnTo = this.safeReturnTo(
        typeof request.query === "object" &&
          request.query &&
          "returnTo" in request.query
          ? String(request.query.returnTo)
          : "/",
      );
      const transaction = await new EncryptJWT({ state, verifier, returnTo })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setIssuedAt()
        .setExpirationTime("10m")
        .encrypt(this.config.sessionKey);
      reply.setCookie(OIDC_COOKIE, transaction, this.cookieOptions(600));
      const url = oidc.buildAuthorizationUrl(provider, {
        redirect_uri: this.config.oidc.redirectUri.href,
        scope: "openid profile email groups",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        prompt: "login",
        max_age: "0",
      });
      return reply.redirect(url.href);
    });

    app.get("/auth/callback", async (request, reply) => {
      if (!this.config.oidc)
        return reply.code(503).send({ error: "oidc_not_configured" });
      const encrypted = request.cookies[OIDC_COOKIE];
      if (!encrypted)
        return reply.code(400).send({ error: "missing_oidc_transaction" });
      let transaction: OidcTransaction;
      try {
        const { payload } = await jwtDecrypt(encrypted, this.config.sessionKey);
        transaction = {
          state: String(payload.state),
          verifier: String(payload.verifier),
          returnTo: this.safeReturnTo(String(payload.returnTo)),
        };
      } catch {
        return reply.code(400).send({ error: "invalid_oidc_transaction" });
      }
      const currentUrl = new URL(request.url, this.config.publicOrigin);
      const tokens = await oidc.authorizationCodeGrant(
        await this.provider(),
        currentUrl,
        {
          pkceCodeVerifier: transaction.verifier,
          expectedState: transaction.state,
        },
      );
      const claims = tokens.claims();
      if (!claims?.sub)
        return reply.code(401).send({ error: "oidc_subject_missing" });
      const rawGroups = claims.groups;
      const groups = Array.isArray(rawGroups)
        ? rawGroups.filter(
            (value): value is string => typeof value === "string",
          )
        : typeof rawGroups === "string"
          ? [rawGroups]
          : [];
      if (!groups.includes(this.config.oidc.ownerGroup)) {
        return reply.code(403).send({ error: "owner_group_required" });
      }
      const name = typeof claims.name === "string" ? claims.name : claims.sub;
      const session = await new SignJWT({ name, groups })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.sub)
        .setAudience("aialra-opencode")
        .setIssuer(this.config.publicOrigin.origin)
        .setIssuedAt()
        .setExpirationTime("8h")
        .sign(this.config.sessionKey);
      reply.clearCookie(OIDC_COOKIE, this.cookieOptions(0));
      reply.setCookie(SESSION_COOKIE, session, this.cookieOptions(28_800));
      reply.setCookie(CSRF_COOKIE, oidc.randomState(), {
        ...this.cookieOptions(28_800),
        httpOnly: false,
      });
      return reply.redirect(transaction.returnTo);
    });

    app.post("/auth/logout", async (request, reply) => {
      if (!this.verifyCsrf(request, reply)) return;
      reply.clearCookie(SESSION_COOKIE, this.cookieOptions(0));
      reply.clearCookie(CSRF_COOKIE, {
        ...this.cookieOptions(0),
        httpOnly: false,
      });
      return reply.code(204).send();
    });
  }

  private provider(): Promise<oidc.Configuration> {
    if (!this.config.oidc)
      return Promise.reject(new Error("OIDC is not configured"));
    this.discovery ??= oidc.discovery(
      this.config.oidc.issuer,
      this.config.oidc.clientId,
      this.config.oidc.clientSecret,
    );
    return this.discovery;
  }

  private safeReturnTo(value: string): string {
    return safeReturnPath(value, this.config.publicOrigin);
  }

  private cookieOptions(maxAge: number) {
    return {
      path: "/",
      httpOnly: true,
      secure: this.config.nodeEnv === "production",
      sameSite: "lax" as const,
      maxAge,
    };
  }
}
