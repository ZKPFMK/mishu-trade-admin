import { config } from "../../../packages/core/src/config.js";
import { database, migrate } from "../../../packages/database/src/index.js";
import {
  syncSources,
  runJob,
  maintenance,
} from "../../../packages/core/src/worker.js";
import { executeOperation } from "../../../packages/core/src/operations.js";
const cfg = config(),
  db = database(cfg.databaseUrl);
await migrate(db);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function loop(name: string, delay: number, fn: () => Promise<unknown>) {
  while (!stopping) {
    try {
      await fn();
    } catch {
      console.error(name + ": retrying after failure");
    }
    await sleep(delay);
  }
}
console.log(
  "Trade worker ready: sync, commands, imports/reconciliation and exports run independently.",
);
await Promise.all([
  loop("sync", 2000, () => syncSources(db, cfg)),
  loop("commands", 1000, () => executeOperation(db, cfg)),
  loop("jobs", 1000, () => runJob(db, cfg, ["import", "reconcile"])),
  loop("exports", 1000, () => runJob(db, cfg, ["export"])),
  loop("maintenance", 10000, () => maintenance(db, cfg)),
]);
await db.end();
