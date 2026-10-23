import type pg from "pg";
import { transaction } from "../../database/src/index.js";
import { audit } from "./audit.js";
import { id, insist } from "./security.js";
export async function reconcile(db: pg.Pool, app: string, run: string) {
  return transaction(db, async (sql) => {
    await sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const a = (
      await sql.query("SELECT * FROM applications WHERE id=$1 FOR UPDATE", [
        app,
      ])
    ).rows[0];
    const pending = (
      await sql.query(
        "SELECT count(*)::int n FROM event_inbox WHERE application_id=$1 AND state<>'applied'",
        [app],
      )
    ).rows[0].n;
    const conflicts = (
      await sql.query(
        "SELECT count(*)::int n FROM event_conflicts WHERE application_id=$1 AND resolved_at IS NULL",
        [app],
      )
    ).rows[0].n;
    if (!a.initialized || pending || conflicts || a.source_error)
      return {
        outcome: "incomplete",
        cursor: a.applied_cursor,
        pending,
        conflicts,
        source_error: a.source_error,
        rule_version: "v1",
        findings: 0,
      };
    const checks: Array<[string, string]> = [
      [
        "transaction_balance",
        `SELECT transaction_id id, sum(amount)::text actual, '0' expected FROM journal_entries WHERE application_id=$1 GROUP BY transaction_id HAVING sum(amount)<>0`,
      ],
      [
        "account_balance",
        `SELECT a.id,a.balance::text actual,(a.opening_balance+COALESCE(sum(e.amount),0))::text expected FROM account_projections a LEFT JOIN journal_entries e ON e.application_id=a.application_id AND e.account_id=a.id WHERE a.application_id=$1 GROUP BY a.application_id,a.id HAVING a.balance<>a.opening_balance+COALESCE(sum(e.amount),0)`,
      ],
      [
        "trade_escrow",
        `SELECT t.id,COALESCE(a.balance,0)::text actual,(CASE WHEN t.status IN ('FUNDED','DELIVERED','DISPUTED') THEN t.price ELSE 0 END)::text expected FROM trade_projections t LEFT JOIN account_projections a ON a.application_id=t.application_id AND a.id='escrow:'||t.id WHERE t.application_id=$1 AND (a.id IS NULL OR a.balance<>(CASE WHEN t.status IN ('FUNDED','DELIVERED','DISPUTED') THEN t.price ELSE 0 END))`,
      ],
      [
        "settlement_split",
        `SELECT t.id,COALESCE(sum(CASE WHEN e.role IN ('seller','fee','creator_royalty','upstream_royalty') THEN e.amount ELSE 0 END),0)::text actual,t.price::text expected FROM trade_projections t LEFT JOIN journal_transactions j ON j.application_id=t.application_id AND j.reference_id=t.id AND j.kind='settle' LEFT JOIN journal_entries e ON e.application_id=j.application_id AND e.transaction_id=j.id WHERE t.application_id=$1 AND t.status IN ('COMPLETED','RESOLVED_SELLER') GROUP BY t.application_id,t.id HAVING COALESCE(sum(CASE WHEN e.role IN ('seller','fee','creator_royalty','upstream_royalty') THEN e.amount ELSE 0 END),0)<>t.price OR count(DISTINCT j.id)<>1 OR COALESCE(sum(CASE WHEN e.account_id='escrow:'||t.id THEN e.amount ELSE 0 END),0)<>-t.price`,
      ],
      [
        "refund_link",
        `SELECT t.id,COALESCE(sum(CASE WHEN e.account_id='user:'||t.buyer_id THEN e.amount ELSE 0 END),0)::text actual,t.price::text expected FROM trade_projections t LEFT JOIN journal_transactions j ON j.application_id=t.application_id AND j.reference_id=t.id AND j.kind='refund' LEFT JOIN journal_entries e ON e.application_id=j.application_id AND e.transaction_id=j.id WHERE t.application_id=$1 AND t.status IN ('REFUNDED','RESOLVED_BUYER') GROUP BY t.application_id,t.id HAVING count(DISTINCT j.id)<>1 OR COALESCE(sum(CASE WHEN e.account_id='user:'||t.buyer_id THEN e.amount ELSE 0 END),0)<>t.price OR COALESCE(sum(CASE WHEN e.account_id='escrow:'||t.id THEN e.amount ELSE 0 END),0)<>-t.price`,
      ],
      [
        "generation_hold",
        `SELECT j.id,COALESCE(a.balance,0)::text actual,(CASE WHEN j.document->>'status'='held' THEN j.document->>'held' ELSE '0' END) expected FROM job_charge_summaries j LEFT JOIN account_projections a ON a.application_id=j.application_id AND a.id='jobs:hold:'||j.id WHERE j.application_id=$1 AND (a.id IS NULL OR a.balance<>(CASE WHEN j.document->>'status'='held' THEN (j.document->>'held')::bigint ELSE 0 END))`,
      ],
      [
        "generation_postings",
        `SELECT g.id,COALESCE(sum(CASE WHEN e.account_id='platform:generation' THEN e.amount ELSE 0 END),0)::text actual,g.document->>'charged' expected FROM job_charge_summaries g LEFT JOIN journal_transactions j ON j.application_id=g.application_id AND j.reference_id=g.id AND j.kind LIKE 'generation_%' LEFT JOIN journal_entries e ON e.application_id=j.application_id AND e.transaction_id=j.id WHERE g.application_id=$1 GROUP BY g.application_id,g.id HAVING COALESCE(sum(CASE WHEN e.account_id='platform:generation' THEN e.amount ELSE 0 END),0)<>(g.document->>'charged')::bigint OR COALESCE(sum(CASE WHEN j.kind='generation_hold' AND e.account_id='jobs:hold:'||g.id THEN e.amount ELSE 0 END),0)<>(g.document->>'held')::bigint`,
      ],
    ];
    let count = 0;
    for (const [rule, query] of checks)
      for (const finding of (await sql.query(query, [app])).rows) {
        const detail = {
          ...finding,
          cursor: a.applied_cursor,
          rule_version: "v1",
        };
        const r = (
          await sql.query(
            "INSERT INTO reconciliation_findings(id,application_id,rule,object_id,detail,first_run,last_run) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(application_id,rule,object_id) DO UPDATE SET detail=$5,last_run=$6,state='open',updated_at=now() RETURNING id",
            [id("diff"), app, rule, finding.id, JSON.stringify(detail), run],
          )
        ).rows[0];
        await sql.query(
          "INSERT INTO reconciliation_observations VALUES($1,$2,$3)",
          [run, r.id, JSON.stringify(detail)],
        );
        count++;
      }
    // Resolution is evidence from a subsequent complete run, never a manual money adjustment.
    await sql.query(
      "UPDATE reconciliation_findings SET state='resolved',resolution_note='后续完整对账未再出现差异',updated_at=now() WHERE application_id=$1 AND last_run<>$2 AND state='open'",
      [app, run],
    );
    const result = {
      outcome: count ? "differences" : "passed",
      cursor: a.applied_cursor,
      cutoff_at: a.last_applied_at,
      rule_version: "v1",
      findings: count,
      rules: checks.length,
      unit: "CREDIT",
      payment_mode: "simulated",
    };
    await audit(sql, app, null, "reconciliation.completed", run, result);
    return result;
  });
}
