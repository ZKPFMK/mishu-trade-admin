import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCb);
export const id = (prefix: string) =>
  `${prefix}_${randomBytes(12).toString("hex")}`;
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .filter((k) => (v as any)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
    .join(",")}}`;
}
export const digest = (v: unknown) => `sha256:${hash(canonical(v))}`;
export class Vault {
  private key: Buffer;
  constructor(hex: string) {
    this.key = Buffer.from(hex, "hex");
    if (this.key.length !== 32) throw new Error("Invalid encryption key");
  }
  seal(v: unknown, aad: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(v), "utf8"),
      cipher.final(),
    ]);
    return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
  }
  open<T = any>(s: string, aad: string): T {
    const [version, iv, tag, body] = s.split(".");
    if (version !== "v1") throw new Error("Unsupported encryption format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(body, "base64")),
        decipher.final(),
      ]).toString(),
    );
  }
  fingerprint(app: string, value: unknown) {
    return createHmac("sha256", this.key)
      .update(app + canonical(value))
      .digest("hex");
  }
}
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${((await scrypt(password, salt, 64)) as Buffer).toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer,
    expected = Buffer.from(hex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export class TradeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function insist(
  value: unknown,
  status: number,
  code: string,
): asserts value {
  if (!value) throw new TradeError(status, code);
}
