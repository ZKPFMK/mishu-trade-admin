import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, ROOT } from "../packages/core/src/config.js";
import { roles, identifier } from "../packages/contracts/src/index.js";
import { database, transaction } from "../packages/database/src/index.js";
import { id, passwordHash } from "../packages/core/src/security.js";
import { audit } from "../packages/core/src/audit.js";
const [emailArg, appArg, roleArg = "viewer"] = process.argv.slice(2);
const email = z.email().parse(emailArg),
  app = identifier.parse(appArg),
  role = z.enum(roles).parse(roleArg),
  password = randomBytes(18).toString("base64url"),
  key = id("operator");
const db = database(config().databaseUrl);
try {
  await transaction(db, async (sql) => {
    await sql.query(
      "INSERT INTO operators(id,email,name,password_hash,roles) VALUES($1,$2,$3,$4,$5)",
      [
        key,
        email.toLowerCase(),
        email.split("@")[0],
        await passwordHash(password),
        [role],
      ],
    );
    await sql.query("INSERT INTO operator_scopes VALUES($1,$2)", [key, app]);
    await audit(sql, app, "local-cli", "operator.created", key, { role });
  });
  const file = path.join(ROOT, ".local", key + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify({ email, password, role, application_id: app }, null, 2) +
      "\n",
    { mode: 0o600 },
  );
  console.log(
    "Created account; credentials saved to " + path.relative(ROOT, file),
  );
} finally {
  await db.end();
}
