import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
export function config() {
  loadEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required. Run npm run local:setup.");
  const production = process.env.NODE_ENV === "production";
  const encryptionKey = process.env.TRADE_ENCRYPTION_KEY || "";
  if (
    production &&
    (process.env.COOKIE_SECURE !== "1" ||
      !/^[a-f0-9]{64}$/i.test(encryptionKey))
  )
    throw new Error(
      "Production requires secure cookies and a 32-byte TRADE_ENCRYPTION_KEY.",
    );
  if (
    process.env.MANAGEMENT_ENABLED === "1" &&
    (!process.env.SOURCE_COMMAND_TOKEN ||
      process.env.SOURCE_COMMAND_TOKEN === process.env.SOURCE_READ_TOKEN ||
      process.env.SOURCE_COMMAND_TOKEN.length < 32)
  )
    throw new Error(
      "Management requires a separate source command token of at least 32 characters.",
    );
  return {
    databaseUrl,
    dataDir: path.resolve(ROOT, process.env.DATA_DIR || "./data"),
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8920),
    secureCookie: process.env.COOKIE_SECURE === "1",
    sourceMode: process.env.SOURCE_MODE || "mock",
    sourceUrl: process.env.SOURCE_URL,
    sourceReadToken: process.env.SOURCE_READ_TOKEN,
    sourceCommandToken: process.env.SOURCE_COMMAND_TOKEN,
    managementEnabled: process.env.MANAGEMENT_ENABLED === "1",
    requireMfa: production || process.env.MANAGEMENT_REQUIRE_MFA === "1",
    encryptionKey,
  };
}
export type Config = ReturnType<typeof config>;
