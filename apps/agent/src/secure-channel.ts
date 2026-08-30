import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  CapabilityGrantSchema,
  type CapabilityGrant,
  type ChannelKind,
  type EncryptedChannelFrame,
  type RelayPayload,
} from "@aialra-opencode/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodeGrant(
  token: string,
  verificationKey: KeyObject,
): CapabilityGrant {
  const [payload, signature] = token.split(".");
  if (
    !payload ||
    !signature ||
    !verify(
      null,
      Buffer.from(payload),
      verificationKey,
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new Error("invalid capability grant signature");
  }
  const grant = CapabilityGrantSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  const now = Math.floor(Date.now() / 1_000);
  if (grant.issuedAt > now + 15 || grant.expiresAt <= now)
    throw new Error("capability grant expired");
  return grant;
}

export class SecureChannel {
  private inboundSequence = 0;
  private outboundSequence = 0;

  private constructor(
    readonly id: string,
    readonly kind: ChannelKind,
    readonly grantToken: string,
    readonly grant: CapabilityGrant,
    private readonly key: Uint8Array,
  ) {}

  static accept(input: {
    channelId: string;
    kind: ChannelKind;
    hostId: string;
    subject: string;
    browserKey: string;
    grantToken: string;
    grantVerificationKey: KeyObject;
    identityPrivateKey: KeyObject;
  }): { channel: SecureChannel; agentEphemeralKey: string; signature: string } {
    const grant = decodeGrant(input.grantToken, input.grantVerificationKey);
    if (grant.hostId !== input.hostId || grant.subject !== input.subject)
      throw new Error("capability grant binding mismatch");
    const privateKey = x25519.utils.randomSecretKey();
    const agentEphemeralKey = Buffer.from(
      x25519.getPublicKey(privateKey),
    ).toString("base64url");
    const shared = x25519.getSharedSecret(
      privateKey,
      Buffer.from(input.browserKey, "base64url"),
    );
    const key = hkdf(
      sha256,
      shared,
      encoder.encode(input.channelId),
      encoder.encode("aialra-opencode-e2e-v1"),
      32,
    );
    const grantHash = Buffer.from(
      sha256(encoder.encode(input.grantToken)),
    ).toString("base64url");
    const canonical = [
      input.channelId,
      input.browserKey,
      agentEphemeralKey,
      grantHash,
    ].join("\n");
    const signature = sign(
      null,
      Buffer.from(canonical),
      input.identityPrivateKey,
    ).toString("base64url");
    return {
      channel: new SecureChannel(
        input.channelId,
        input.kind,
        input.grantToken,
        grant,
        key,
      ),
      agentEphemeralKey,
      signature,
    };
  }

  decrypt(frame: EncryptedChannelFrame): RelayPayload {
    if (
      frame.channelId !== this.id ||
      frame.channel !== this.kind ||
      frame.sequence !== this.inboundSequence
    ) {
      throw new Error("encrypted frame sequence or channel mismatch");
    }
    const aad = encoder.encode(`${this.id}\n${this.kind}\n${frame.sequence}`);
    const sealed = new Uint8Array([
      ...Buffer.from(frame.ciphertext, "base64url"),
      ...Buffer.from(frame.tag, "base64url"),
    ]);
    const plaintext = xchacha20poly1305(
      this.key,
      Buffer.from(frame.nonce, "base64url"),
      aad,
    ).decrypt(sealed);
    this.inboundSequence += 1;
    return JSON.parse(decoder.decode(plaintext)) as RelayPayload;
  }

  encrypt(payload: RelayPayload): EncryptedChannelFrame {
    const sequence = this.outboundSequence++;
    const nonce = randomBytes(24);
    const aad = encoder.encode(`${this.id}\n${this.kind}\n${sequence}`);
    const sealed = xchacha20poly1305(this.key, nonce, aad).encrypt(
      encoder.encode(JSON.stringify(payload)),
    );
    return {
      channelId: this.id,
      channel: this.kind,
      sequence,
      nonce: Buffer.from(nonce).toString("base64url"),
      ciphertext: Buffer.from(sealed.slice(0, -16)).toString("base64url"),
      tag: Buffer.from(sealed.slice(-16)).toString("base64url"),
    };
  }

  allows(scope: CapabilityGrant["scopes"][number]): boolean {
    return (
      this.grant.expiresAt > Math.floor(Date.now() / 1_000) &&
      this.grant.scopes.includes(scope)
    );
  }
}

export function grantPublicKey(pem: string): KeyObject {
  return createPublicKey(pem);
}
