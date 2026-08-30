import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  CapabilityGrantSchema,
  type CapabilityGrant,
} from "@aialra-opencode/protocol";

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export class FieldCipher {
  constructor(private readonly key: Uint8Array) {}

  encrypt(plaintext: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      encode(nonce),
      encode(ciphertext),
      encode(cipher.getAuthTag()),
    ].join(".");
  }

  decrypt(value: string, context: string): string {
    const [version, nonceValue, ciphertextValue, tagValue] = value.split(".");
    if (version !== "v1" || !nonceValue || !ciphertextValue || !tagValue) {
      throw new Error("Unsupported encrypted field format");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      decode(nonceValue),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(decode(tagValue));
    return Buffer.concat([
      decipher.update(decode(ciphertextValue)),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function stableHash(value: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export class GrantSigner {
  private readonly privateKey;
  readonly publicKeyPem: string;

  constructor(privateKeyPem: string) {
    this.privateKey = createPrivateKey(privateKeyPem);
    this.publicKeyPem = createPublicKey(this.privateKey)
      .export({ format: "pem", type: "spki" })
      .toString();
  }

  issue(grant: CapabilityGrant): string {
    const payload = CapabilityGrantSchema.parse(grant);
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${sign(null, Buffer.from(encoded), this.privateKey).toString("base64url")}`;
  }

  verify(token: string): CapabilityGrant {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) throw new Error("Malformed capability grant");
    if (
      !verify(
        null,
        Buffer.from(encoded),
        createPublicKey(this.privateKey),
        decode(signature),
      )
    ) {
      throw new Error("Invalid capability grant signature");
    }
    const grant = CapabilityGrantSchema.parse(
      JSON.parse(decode(encoded).toString("utf8")),
    );
    const now = Math.floor(Date.now() / 1000);
    if (grant.issuedAt > now + 15 || grant.expiresAt <= now)
      throw new Error("Capability grant expired");
    return grant;
  }
}
