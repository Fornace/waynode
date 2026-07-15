import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.mjs";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretCryptoError extends Error {
  constructor(message = "Encrypted value is unavailable") {
    super(message);
    this.name = "SecretCryptoError";
  }
}

function keyBytes(keyHex) {
  if (typeof keyHex !== "string" || keyHex.length !== 64) {
    throw new SecretCryptoError("ENCRYPTION_KEY must be exactly 64 hexadecimal characters");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32 || key.toString("hex") !== keyHex.toLowerCase()) {
    throw new SecretCryptoError("ENCRYPTION_KEY must be exactly 64 hexadecimal characters");
  }
  return key;
}

function decodedPayload(payload) {
  if (typeof payload !== "string" || !payload.length) throw new SecretCryptoError();
  const data = Buffer.from(payload, "base64");
  if (data.length <= IV_BYTES + TAG_BYTES || data.toString("base64") !== payload) {
    throw new SecretCryptoError();
  }
  return data;
}

/** Small injectable codec; production callers use the configured master key. */
export function createSecretCodec(keyHex = config.encryptionKey) {
  const key = keyBytes(keyHex);
  return {
    encrypt(plaintext, context = "") {
      if (typeof plaintext !== "string" || !plaintext.length) throw new SecretCryptoError();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      if (context) cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt(payload, context = "") {
      try {
        const data = decodedPayload(payload);
        const decipher = createDecipheriv(ALGORITHM, key, data.subarray(0, IV_BYTES));
        if (context) decipher.setAAD(Buffer.from(context));
        decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([
          decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        if (error instanceof SecretCryptoError) throw error;
        throw new SecretCryptoError();
      }
    },
  };
}

let configuredCodec;
export function secretCodec() {
  configuredCodec ||= createSecretCodec();
  return configuredCodec;
}
