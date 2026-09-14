import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { CONFIG } from "../infra/config";

export interface CipherText {
  cipher: string;
  iv: string;
  tag: string;
}

export function contextKeyFromString(value: string): Buffer {
  const raw = value.trim();
  if (!raw) throw new Error("DAILY_ASSISTANT_CONTEXT_KEY 未配置");
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const base64 = Buffer.from(raw, "base64");
  if (base64.length === 32 && base64.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "")) return base64;
  if (raw.length < 32) throw new Error("DAILY_ASSISTANT_CONTEXT_KEY 至少需要 32 个字符或 32 字节 Base64/Hex");
  return createHash("sha256").update(raw, "utf8").digest();
}

export function configuredContextKey(): Buffer {
  return contextKeyFromString(CONFIG.assistant.contextEncryptionKey);
}

export function encryptJson(value: unknown, key: Buffer, associatedData: string): CipherText {
  if (key.length !== 32) throw new Error("上下文加密密钥必须为 32 字节");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    cipher: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptJson<T>(value: CipherText, key: Buffer, associatedData: string): T {
  if (key.length !== 32) throw new Error("上下文加密密钥必须为 32 字节");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(value.cipher, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as T;
}
