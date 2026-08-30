import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FieldCipher, GrantSigner } from "../src/crypto.js";

describe("control-plane cryptography", () => {
  it("binds encrypted fields to their database context", () => {
    const cipher = new FieldCipher(randomBytes(32));
    const encrypted = cipher.encrypt("private", "host-a:title");
    expect(cipher.decrypt(encrypted, "host-a:title")).toBe("private");
    expect(() => cipher.decrypt(encrypted, "host-b:title")).toThrow();
  });

  it("issues signed, short-lived capability grants", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new GrantSigner(
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    const now = Math.floor(Date.now() / 1000);
    const token = signer.issue({
      grantId: randomUUID(),
      subject: "owner",
      hostId: "host-alpha",
      scopes: ["http.read"],
      issuedAt: now,
      expiresAt: now + 60,
      nonce: randomBytes(24).toString("base64url"),
    });
    expect(signer.verify(token).hostId).toBe("host-alpha");
    const [payload, signature] = token.split(".") as [string, string];
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(() => signer.verify(`${payload}.${tamperedSignature}`)).toThrow();
  });
});
