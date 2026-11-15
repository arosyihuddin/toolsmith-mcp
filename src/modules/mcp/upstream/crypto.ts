/**
 * Encryption of upstream secrets at rest, following the same pattern
 * as root-command passwords in control-plane/root-commands.ts:
 * AES-256-GCM with the TOOLSMITH_SUDO_ENCRYPTION_KEY, stored as
 * `iv.tag.ciphertext` (base64 parts joined by ".").
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const value = process.env.TOOLSMITH_SUDO_ENCRYPTION_KEY;
  if (!value || value.length < 32)
    throw new Error(
      "TOOLSMITH_SUDO_ENCRYPTION_KEY harus diatur (minimal 32 karakter) sebelum menyimpan secret upstream.",
    );
  return Buffer.from(value, "utf8").subarray(0, 32);
}

export function isSecretEncryptionConfigured(): boolean {
  const value = process.env.TOOLSMITH_SUDO_ENCRYPTION_KEY;
  return !!value && value.length >= 32;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptSecret(value: string): string {
  const [iv, tag, data] = value.split(".");
  if (!iv || !tag || !data) throw new Error("Invalid encrypted upstream secret");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
