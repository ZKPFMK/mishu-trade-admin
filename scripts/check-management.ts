/** Read-only checks; no schema migrations or source business commands. */
import { config } from "../packages/core/src/config.js";
import { database } from "../packages/database/src/index.js";
const cfg = config(),
  db = database(cfg.databaseUrl),
  strict = process.argv.includes("--production");
let failed = 0;
const check = (name: string, ok: unknown) => {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) failed++;
};
try {
  check(
    "Separate command credential enabled",
    cfg.managementEnabled &&
      cfg.sourceCommandToken &&
      cfg.sourceCommandToken !== cfg.sourceReadToken,
  );
  check(
    "MFA seed encryption configured",
    /^[a-f0-9]{64}$/i.test(cfg.encryptionKey),
  );
  check(
    "Management database migration present",
    (
      await db.query(
        "SELECT 1 FROM schema_migrations WHERE name='004_management.sql'",
      )
    ).rowCount,
  );
  if (strict) {
    check("Production secure cookies", cfg.secureCookie);
    check("MFA required globally", cfg.requireMfa);
  }
  const response = await fetch(
    new URL("/internal/trade-admin/status", cfg.sourceUrl!),
    {
      headers: { authorization: "Bearer " + cfg.sourceReadToken },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  check("Source reachable", response.ok);
  if (!response.ok) throw Error("source_unavailable");
  const source = (await response.json()) as any;
  check("Source management execution enabled", source.write_commands === true);
  const apps = (
    await db.query(
      "SELECT * FROM applications WHERE enabled AND source_mode='mishu' AND management_enabled",
    )
  ).rows;
  check("Exactly one real management source", apps.length === 1);
  for (const a of apps) {
    check(
      a.id + ": identity matches initialized projection",
      a.initialized && a.applied_cursor?.startsWith(source.source_id + ":"),
    );
    check(
      a.id + ": source sync healthy",
      !a.source_error &&
        a.last_poll_at &&
        Date.now() - new Date(a.last_poll_at).getTime() < 30000,
    );
    const staff = (
      await db.query(
        "SELECT o.id,o.email,o.roles,m.secret IS NOT NULL mfa FROM operators o JOIN operator_scopes s ON s.operator_id=o.id LEFT JOIN operator_mfa m ON m.operator_id=o.id WHERE s.application_id=$1 AND o.enabled",
        [a.id],
      )
    ).rows;
    check(
      a.id + ": distinct applicant and approver",
      staff.some(
        (x) =>
          x.roles.includes("operator") &&
          staff.some((y) => y.id !== x.id && y.roles.includes("approver")),
      ),
    );
    if (strict) {
      check(a.id + ": marked production", a.environment === "production");
      check(
        a.id + ": operating staff enrolled in MFA",
        staff
          .filter((x) =>
            x.roles.some((r: string) => ["operator", "approver"].includes(r)),
          )
          .every((x) => x.mfa),
      );
      check(
        a.id + ": local bootstrap accounts disabled",
        !staff.some((x) => x.email.endsWith("@trade-admin.local")),
      );
    }
    check(
      a.id + ": no unresolved command outcomes",
      !(
        await db.query(
          "SELECT 1 FROM management_requests WHERE application_id=$1 AND state='execution_unknown' LIMIT 1",
          [a.id],
        )
      ).rowCount,
    );
    check(
      a.id + ": no blocked synchronization events",
      !(
        await db.query(
          "SELECT 1 FROM event_inbox WHERE application_id=$1 AND state IN ('blocked','quarantined') LIMIT 1",
          [a.id],
        )
      ).rowCount,
    );
    const run = (
      await db.query(
        "SELECT result->>'outcome' outcome,updated_at finished_at FROM jobs WHERE application_id=$1 AND kind='reconcile' AND state='succeeded' ORDER BY created_at DESC LIMIT 1",
        [a.id],
      )
    ).rows[0];
    check(
      a.id + ": recent reconciliation passed",
      run?.outcome === "passed" &&
        run.finished_at &&
        Date.now() - new Date(run.finished_at).getTime() < 86400000,
    );
  }
  console.log(
    "Checks do not replace target-environment HTTPS, backup restore, monitoring or load acceptance.",
  );
} catch {
  failed++;
  console.error(
    "Check could not complete; verify connection, migrations and service state. No credentials printed.",
  );
} finally {
  await db.end();
  process.exitCode = failed ? 1 : 0;
}
