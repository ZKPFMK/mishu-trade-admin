import { config } from "../../../packages/core/src/config.js";
import { database, migrate } from "../../../packages/database/src/index.js";
import { createApp } from "./app.js";
const cfg = config(),
  db = database(cfg.databaseUrl);
await migrate(db);
const app = await createApp(db, cfg);
await app.listen({ host: cfg.host, port: cfg.port });
console.log(`Trade Admin ready on http://${cfg.host}:${cfg.port}`);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
  await db.end();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
