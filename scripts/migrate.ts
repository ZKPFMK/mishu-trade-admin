import { config } from "../packages/core/src/config.js";
import { database, migrate } from "../packages/database/src/index.js";
const db = database(config().databaseUrl);
try {
  await migrate(db);
  console.log("Migrations applied");
} finally {
  await db.end();
}
