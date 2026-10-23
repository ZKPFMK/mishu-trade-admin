import type pg from "pg";
import {
  bundleSchema,
  eventSchema,
  snapshotSchema,
  type Bundle,
  type SourceEvent,
  type Snapshot,
} from "../../contracts/src/index.js";
import { transaction, type Sql } from "../../database/src/index.js";
import { digest, id, insist, TradeError } from "./security.js";
import { audit } from "./audit.js";

export function validateBundle(raw: unknown, full = false): Bundle {
  const bundle = bundleSchema.parse(raw);
  for (const records of [
    bundle.trades,
    bundle.accounts,
    bundle.journals,
    bundle.jobs,
  ])
    insist(
      new Set(records.map((x) => x.id)).size === records.length,
      422,
      "duplicate_object",
    );
  const entryIds = new Set<string>(),
    accounts = new Map(bundle.accounts.map((a) => [a.id, a])),
    totals = new Map<string, bigint>();
  for (const tx of bundle.journals) {
    insist(
      tx.entries.reduce((sum, e) => sum + BigInt(e.amount), 0n) === 0n,
      422,
      "unbalanced_transaction",
    );
    for (const entry of tx.entries) {
      insist(!entryIds.has(entry.id), 422, "duplicate_entry");
      entryIds.add(entry.id);
      if (full) insist(accounts.has(entry.account_id), 422, "missing_account");
      totals.set(
        entry.account_id,
        (totals.get(entry.account_id) || 0n) + BigInt(entry.amount),
      );
    }
  }
  if (full)
    for (const a of bundle.accounts) {
      insist(
        BigInt(a.opening_balance) === 0n,
        422,
        "full_history_requires_zero_opening",
      );
      insist(
        (totals.get(a.id) || 0n) === BigInt(a.balance),
        422,
        "account_balance_mismatch",
      );
    }
  return bundle;
}

async function writeBundle(
  sql: Sql,
  app: string,
  bundle: Bundle,
  snapshot = false,
) {
  // Validate all immutable transactions before mutating any projections.
  const changes = new Map<string, bigint>();
  for (const j of bundle.journals) {
    const old = (
      await sql.query(
        "SELECT digest FROM journal_transactions WHERE application_id=$1 AND id=$2",
        [app, j.id],
      )
    ).rows[0];
    if (old) {
      insist(old.digest === digest(j), 409, "immutable_journal_conflict");
      continue;
    }
    for (const e of j.entries)
      changes.set(
        e.account_id,
        (changes.get(e.account_id) || 0n) + BigInt(e.amount),
      );
  }
  for (const a of bundle.accounts) {
    const old = (
      await sql.query(
        "SELECT * FROM account_projections WHERE application_id=$1 AND id=$2",
        [app, a.id],
      )
    ).rows[0];
    if (old && !snapshot) {
      if (BigInt(a.version) <= BigInt(old.version)) {
        insist(!changes.get(a.id), 409, "stale_account_with_new_entries");
        if (a.version === old.version)
          insist(
            digest(a) === digest(old.document),
            409,
            "object_version_conflict",
          );
        continue;
      }
      insist(
        BigInt(a.version) === BigInt(old.version) + 1n,
        409,
        "version_gap",
      );
      insist(
        a.opening_balance === old.opening_balance,
        409,
        "opening_balance_changed",
      );
    } else if (!snapshot)
      insist(
        a.version === "1" && a.opening_balance === "0",
        409,
        "version_gap",
      );
    if (!snapshot)
      insist(
        BigInt(old?.balance || a.opening_balance) +
          (changes.get(a.id) || 0n) ===
          BigInt(a.balance),
        422,
        "account_delta_mismatch",
      );
    await sql.query(
      `INSERT INTO account_projections VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(application_id,id) DO UPDATE SET version=$3,owner_id=$4,kind=$5,balance=$6,opening_balance=$7,document=$8`,
      [
        app,
        a.id,
        a.version,
        a.owner_id,
        a.kind,
        a.balance,
        a.opening_balance,
        JSON.stringify(a),
      ],
    );
    changes.delete(a.id);
  }
  insist(
    snapshot || [...changes.values()].every((v) => v === 0n),
    422,
    "missing_account_update",
  );
  for (const t of bundle.trades) {
    const old = (
      await sql.query(
        "SELECT version,document FROM trade_projections WHERE application_id=$1 AND id=$2",
        [app, t.id],
      )
    ).rows[0];
    if (old && !snapshot) {
      if (BigInt(t.version) <= BigInt(old.version)) {
        if (t.version === old.version)
          insist(
            digest(t) === digest(old.document),
            409,
            "object_version_conflict",
          );
        continue;
      }
      insist(
        BigInt(t.version) === BigInt(old.version) + 1n,
        409,
        "version_gap",
      );
    } else if (!snapshot) insist(t.version === "1", 409, "version_gap");
    await sql.query(
      `INSERT INTO trade_projections VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(application_id,id) DO UPDATE SET version=$3,status=$4,buyer_id=$5,seller_id=$6,asset_id=$7,price=$8,created_at=$9,updated_at=$10,document=$11`,
      [
        app,
        t.id,
        t.version,
        t.status,
        t.buyer_id,
        t.seller_id,
        t.asset_id,
        t.price,
        t.created_at,
        t.updated_at,
        JSON.stringify(t),
      ],
    );
  }
  for (const j of bundle.journals) {
    const result = await sql.query(
      "INSERT INTO journal_transactions VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [
        app,
        j.id,
        j.kind,
        j.reference_id,
        j.occurred_at,
        digest(j),
        JSON.stringify(j),
      ],
    );
    if (result.rowCount)
      for (const e of j.entries)
        await sql.query(
          "INSERT INTO journal_entries VALUES($1,$2,$3,$4,$5,$6)",
          [app, e.id, j.id, e.account_id, e.amount, e.role],
        );
  }
  for (const job of bundle.jobs) {
    const old = (
      await sql.query(
        "SELECT version,document FROM job_charge_summaries WHERE application_id=$1 AND id=$2",
        [app, job.id],
      )
    ).rows[0];
    if (!snapshot) {
      if (old && BigInt(job.version) <= BigInt(old.version)) {
        if (job.version === old.version)
          insist(
            digest(job) === digest(old.document),
            409,
            "object_version_conflict",
          );
        continue;
      }
      insist(
        BigInt(job.version) === BigInt(old?.version || "0") + 1n,
        409,
        "version_gap",
      );
    }
    await sql.query(
      "INSERT INTO job_charge_summaries VALUES($1,$2,$3,$4) ON CONFLICT(application_id,id) DO UPDATE SET version=$3,document=$4",
      [app, job.id, job.version, JSON.stringify(job)],
    );
  }
}

export async function receiveEvent(db: pg.Pool, app: string, raw: unknown) {
  const event = eventSchema.parse(raw),
    hash = digest(event);
  return transaction(db, async (sql) => {
    await sql.query("SELECT id FROM applications WHERE id=$1 FOR UPDATE", [
      app,
    ]);
    const old = (
      await sql.query(
        "SELECT * FROM event_inbox WHERE application_id=$1 AND (event_id=$2 OR source_cursor=$3)",
        [app, event.event_id, event.source_cursor],
      )
    ).rows[0];
    if (old) {
      if (old.digest === hash && old.event_id === event.event_id)
        return { event_id: event.event_id, state: old.state, duplicate: true };
      const inserted = await sql.query(
        "INSERT INTO event_conflicts(application_id,event_id,original_digest,incoming_digest) VALUES($1,$2,$3,$4) ON CONFLICT(application_id,event_id,incoming_digest) DO NOTHING",
        [app, event.event_id, old.digest, hash],
      );
      if (inserted.rowCount)
        await audit(sql, app, null, "event.conflict", event.event_id, {
          original_digest: old.digest,
          incoming_digest: hash,
        });
      return { event_id: event.event_id, state: "conflict", duplicate: false };
    }
    await sql.query(
      "INSERT INTO event_inbox(application_id,event_id,source_cursor,previous_cursor,digest,body) VALUES($1,$2,$3,$4,$5,$6)",
      [
        app,
        event.event_id,
        event.source_cursor,
        event.previous_cursor,
        hash,
        JSON.stringify(event),
      ],
    );
    await sql.query("UPDATE applications SET received_cursor=$2 WHERE id=$1", [
      app,
      event.source_cursor,
    ]);
    return { event_id: event.event_id, state: "received", duplicate: false };
  });
}
export async function applyNextEvent(db: pg.Pool, app: string) {
  return transaction(db, async (sql) => {
    const application = (
      await sql.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
        app,
      ])
    ).rows[0];
    if (!application?.initialized) return false;
    const row = (
      await sql.query(
        "SELECT * FROM event_inbox WHERE application_id=$1 AND state IN ('received','blocked') AND previous_cursor IS NOT DISTINCT FROM $2 ORDER BY seq LIMIT 1",
        [app, application.applied_cursor],
      )
    ).rows[0];
    if (!row) {
      await sql.query(
        "UPDATE event_inbox SET state='blocked',error='cursor_gap' WHERE application_id=$1 AND state='received'",
        [app],
      );
      return false;
    }
    await sql.query("SAVEPOINT apply_event");
    try {
      const event = eventSchema.parse(row.body);
      insist(
        event.source_cursor !== event.previous_cursor,
        422,
        "cursor_cycle",
      );
      await writeBundle(sql, app, validateBundle(event.bundle));
      await sql.query(
        "UPDATE event_inbox SET state='applied',applied_at=now(),error=NULL,attempts=attempts+1 WHERE seq=$1",
        [row.seq],
      );
      await sql.query(
        "UPDATE applications SET applied_cursor=$2,last_applied_at=now() WHERE id=$1",
        [app, event.source_cursor],
      );
    } catch (e) {
      await sql.query("ROLLBACK TO SAVEPOINT apply_event");
      const error = e instanceof TradeError ? e.code : "invalid_event";
      await sql.query(
        "UPDATE event_inbox SET state='quarantined',error=$2,attempts=attempts+1 WHERE seq=$1",
        [row.seq, error],
      );
      await audit(sql, app, null, "event.quarantined", row.event_id, { error });
    }
    return true;
  });
}
export async function importSnapshot(
  db: pg.Pool,
  app: string,
  raw: unknown,
  jobId?: string,
) {
  const snap = snapshotSchema.parse(raw);
  insist(
    digest(snap.bundle) === snap.checksum,
    422,
    "snapshot_checksum_mismatch",
  );
  const bundle = validateBundle(snap.bundle, true);
  return transaction(db, async (sql) => {
    const current = (
      await sql.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
        app,
      ])
    ).rows[0];
    insist(current && !current.initialized, 409, "already_initialized");
    await writeBundle(sql, app, bundle, true);
    await sql.query(
      "UPDATE applications SET initialized=true,applied_cursor=$2,received_cursor=$2,last_applied_at=now() WHERE id=$1",
      [app, snap.cursor],
    );
    await audit(sql, app, null, "snapshot.applied", snap.snapshot_id, {
      cursor: snap.cursor,
      checksum: snap.checksum,
      trades: bundle.trades.length,
      journals: bundle.journals.length,
    });
    const result = {
      cursor: snap.cursor,
      trades: bundle.trades.length,
      journals: bundle.journals.length,
      accounts: bundle.accounts.length,
    };
    if (jobId) await audit(sql, app, null, "import.activated", jobId, result);
    return result;
  });
}
export async function queueJob(
  db: Sql,
  app: string,
  owner: string | null,
  kind: "export" | "import" | "reconcile",
  payload: unknown = {},
) {
  const jobId = id(kind);
  await db.query(
    "INSERT INTO jobs(id,application_id,owner_id,kind,payload) VALUES($1,$2,$3,$4,$5)",
    [jobId, app, owner, kind, JSON.stringify(payload)],
  );
  await audit(db, app, owner, kind + ".queued", jobId);
  return jobId;
}
