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
  return {
    databaseUrl,
    dataDir: path.resolve(ROOT, process.env.DATA_DIR || "./data"),
    host: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT || 8920),
    secureCookie: process.env.COOKIE_SECURE === "1",
    sourceMode: process.env.SOURCE_MODE || "mock",
    sourceUrl: process.env.SOURCE_URL,
    sourceReadToken: process.env.SOURCE_READ_TOKEN,
  };
}
export type Config = ReturnType<typeof config>;
