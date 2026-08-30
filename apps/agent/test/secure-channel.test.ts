import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { SecureChannel } from "../src/secure-channel.js";

const encoder = new TextEncoder();

function fixture(expiresAt = Math.floor(Date.now() / 1_000) + 60) {
  const grantKeys = generateKeyPairSync("ed25519");
  const identityKeys = generateKeyPairSync("ed25519");
  const browserPrivateKey = x25519.utils.randomSecretKey();
  const browserKey = Buffer.from(
    x25519.getPublicKey(browserPrivateKey),
  ).toString("base64url");
  const channelId = "2c82eedc-d63b-4c78-afd6-4916cb2c770e";
  const grant = {
    grantId: "92b11e67-6f24-474f-9510-816e92a6a69f",
    subject: "owner",
    hostId: "host-alpha",
    scopes: ["http.read"] as const,
    issuedAt: Math.floor(Date.now() / 1_000),
    expiresAt,
    nonce: "unique-capability-grant-nonce",
  };
  const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const token = `${encoded}.${sign(null, Buffer.from(encoded), grantKeys.privateKey).toString("base64url")}`;
  const accepted = SecureChannel.accept({
    channelId,
    kind: "opencode-http",
    hostId: grant.hostId,
    subject: grant.subject,
    browserKey,
    grantToken: token,
    grantVerificationKey: createPublicKey(grantKeys.privateKey),
    identityPrivateKey: identityKeys.privateKey,
  });
  const shared = x25519.getSharedSecret(
    browserPrivateKey,
    Buffer.from(accepted.agentEphemeralKey, "base64url"),
  );
  const key = hkdf(
    sha256,
    shared,
    encoder.encode(channelId),
    encoder.encode("aialra-opencode-e2e-v1"),
    32,
  );
  const frame = (sequence: number, value: unknown) => {
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const aad = encoder.encode(`${channelId}\nopencode-http\n${sequence}`);
    const sealed = xchacha20poly1305(key, nonce, aad).encrypt(
      encoder.encode(JSON.stringify(value)),
    );
    return {
      channelId,
      channel: "opencode-http" as const,
      sequence,
      nonce: Buffer.from(nonce).toString("base64url"),
      ciphertext: Buffer.from(sealed.slice(0, -16)).toString("base64url"),
      tag: Buffer.from(sealed.slice(-16)).toString("base64url"),
    };
  };
  return {
    accepted,
    frame,
    token,
    grantKeys,
    identityKeys,
    browserKey,
    channelId,
  };
}

describe("secure relay channel", () => {
  it("decrypts one in-order frame and rejects replay", () => {
    const { accepted, frame } = fixture();
    const encrypted = frame(0, {
      type: "relay.http.cancel",
      requestId: "2c82eedc-d63b-4c78-afd6-4916cb2c770e",
    });
    expect(accepted.channel.decrypt(encrypted).type).toBe("relay.http.cancel");
    expect(() => accepted.channel.decrypt(encrypted)).toThrow(/sequence/u);
  });

  it("rejects out-of-order and wrong-channel frames", () => {
    const { accepted, frame } = fixture();
    expect(() => accepted.channel.decrypt(frame(1, { type: "x" }))).toThrow(
      /sequence/u,
    );
    expect(() =>
      accepted.channel.decrypt({
        ...frame(0, { type: "x" }),
        channel: "opencode-event",
      }),
    ).toThrow(/channel/u);
  });

  it("rejects expired grants before a channel is accepted", () => {
    expect(() => fixture(Math.floor(Date.now() / 1_000) - 1)).toThrow(
      /expired/u,
    );
  });

  it("binds grants to the exact host and subject", () => {
    const { token, grantKeys, identityKeys, browserKey, channelId } = fixture();
    expect(() =>
      SecureChannel.accept({
        channelId,
        kind: "opencode-http",
        hostId: "host-bravo",
        subject: "owner",
        browserKey,
        grantToken: token,
        grantVerificationKey: createPublicKey(grantKeys.privateKey),
        identityPrivateKey: identityKeys.privateKey,
      }),
    ).toThrow(/binding/u);
  });
});
