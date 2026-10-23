import type pg from "pg";
import { transaction } from "../../database/src/index.js";
import type {
  FinancialTotals,
  Overview,
  TrendPoint,
} from "../../contracts/src/analytics.js";
import type { Filters } from "./queries.js";

const dayMs = 86400000;
const financialFields: (keyof FinancialTotals)[] = [
  "settled",
  "refunded",
  "fees",
  "royalties",
  "seller_income",
  "creator_royalties",
  "upstream_royalties",
  "settled_count",
  "refund_count",
];
const zero = (): FinancialTotals =>
  Object.fromEntries(financialFields.map((k) => [k, "0"])) as FinancialTotals;
const timestamp = (day: string) => Date.parse(day + "T00:00:00Z");
const dateAfter = (day: string, days: number) =>
  new Date(timestamp(day) + days * dayMs).toISOString().slice(0, 10);
const todayShanghai = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
function totalsOf(rows: FinancialTotals[]): FinancialTotals {
  return Object.fromEntries(
    financialFields.map((k) => [
      k,
      rows.reduce((n, r) => n + BigInt(r[k]), 0n).toString(),
    ]),
  ) as FinancialTotals;
}
// Timestamp predicates retain the application/time indexes; date arithmetic only groups the selected rows.
const financialSelect = `COALESCE(sum(CASE WHEN j.kind='settle' AND e.role='escrow' THEN -e.amount::numeric ELSE 0 END),0)::text settled,
 COALESCE(sum(CASE WHEN j.kind='refund' AND e.role='buyer' THEN e.amount ELSE 0 END),0)::text refunded,
 COALESCE(sum(CASE WHEN j.kind='settle' AND e.role='fee' THEN e.amount ELSE 0 END),0)::text fees,
 COALESCE(sum(CASE WHEN j.kind='settle' AND e.role IN ('creator_royalty','upstream_royalty') THEN e.amount ELSE 0 END),0)::text royalties,
 COALESCE(sum(CASE WHEN j.kind='settle' AND e.role='seller' THEN e.amount ELSE 0 END),0)::text seller_income,
 COALESCE(sum(CASE WHEN j.kind='settle' AND e.role='creator_royalty' THEN e.amount ELSE 0 END),0)::text creator_royalties,
 COALESCE(sum(CASE WHEN j.kind='settle' AND e.role='upstream_royalty' THEN e.amount ELSE 0 END),0)::text upstream_royalties,
 count(DISTINCT j.id) FILTER(WHERE j.kind='settle')::text settled_count,
 count(DISTINCT j.id) FILTER(WHERE j.kind='refund')::text refund_count`;
const financialFrom = `FROM journal_transactions j JOIN journal_entries e ON e.application_id=j.application_id AND e.transaction_id=j.id
 WHERE j.application_id=$1 AND j.kind IN ('settle','refund') AND j.occurred_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND j.occurred_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`;
const ordersWhere = `application_id=$1 AND created_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
 AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')`;

export async function overview(
  db: pg.Pool,
  app: string,
  filter: Pick<Filters, "from" | "to">,
): Promise<Overview> {
  return transaction(db, async (sql) => {
    await sql.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const today = todayShanghai();
    let first = today,
      last = today;
    if (!filter.from || !filter.to) {
      const bounds = (
        await sql.query(
          `SELECT to_char(min(at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') first,
        to_char(max(at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') last FROM (
        SELECT min(created_at) at FROM trade_projections WHERE application_id=$1 UNION ALL
        SELECT max(created_at) FROM trade_projections WHERE application_id=$1 UNION ALL
        SELECT min(occurred_at) FROM journal_transactions WHERE application_id=$1 AND kind IN ('settle','refund') UNION ALL
        SELECT max(occurred_at) FROM journal_transactions WHERE application_id=$1 AND kind IN ('settle','refund')) dates`,
          [app],
        )
      ).rows[0];
      first = bounds.first || today;
      last = [bounds.last || today, today].sort().at(-1)!;
    }
    const to = filter.to || [last, filter.from || last].sort().at(-1)!,
      from = filter.from || [first, to].sort()[0];
    const days = Math.round((timestamp(to) - timestamp(from)) / dayMs) + 1,
      bucketDays = Math.max(1, Math.ceil(days / 90));
    const values = [app, from, to];
    const financial = (
      await sql.query(
        `SELECT floor(((j.occurred_at AT TIME ZONE 'Asia/Shanghai')::date-$2::date)/$4::numeric)::int bucket,
      ${financialSelect} ${financialFrom} GROUP BY bucket ORDER BY bucket`,
        [...values, bucketDays],
      )
    ).rows;
    const orderTrend = (
      await sql.query(
        `SELECT floor(((created_at AT TIME ZONE 'Asia/Shanghai')::date-$2::date)/$4::numeric)::int bucket,count(*)::text count
      FROM trade_projections WHERE ${ordersWhere} GROUP BY bucket`,
        [...values, bucketDays],
      )
    ).rows;
    const financialByBucket = new Map<number, FinancialTotals>(
      financial.map((r) => [r.bucket, r]),
    );
    const ordersByBucket = new Map<number, string>(
      orderTrend.map((r) => [r.bucket, r.count]),
    );
    const trend: TrendPoint[] = Array.from(
      { length: Math.ceil(days / bucketDays) },
      (_, bucket) => {
        const row = financialByBucket.get(bucket) || zero();
        return {
          ...(Object.fromEntries(
            financialFields.map((key) => [key, row[key]]),
          ) as FinancialTotals),
          day: dateAfter(from, bucket * bucketDays),
          to: dateAfter(
            from,
            Math.min(days - 1, (bucket + 1) * bucketDays - 1),
          ),
          orders: ordersByBucket.get(bucket) || "0",
          amount: row.settled,
        };
      },
    );
    const totals = totalsOf(trend);
    let comparison: Overview["comparison"] = null;
    if (
      filter.from &&
      filter.to &&
      timestamp(from) - days * dayMs >= timestamp("0001-01-01")
    ) {
      const previousFrom = dateAfter(from, -days),
        previousTo = dateAfter(from, -1);
      comparison = {
        from: previousFrom,
        to: previousTo,
        totals: (
          await sql.query(`SELECT ${financialSelect} ${financialFrom}`, [
            app,
            previousFrom,
            previousTo,
          ])
        ).rows[0],
      };
    }
    const orders = (
      await sql.query(
        `SELECT count(*)::text count,COALESCE(sum(price),0)::text amount,count(DISTINCT buyer_id)::text buyers,count(DISTINCT seller_id)::text sellers FROM trade_projections WHERE ${ordersWhere}`,
        values,
      )
    ).rows[0];
    const statuses = (
      await sql.query(
        `SELECT status,count(*)::text count,sum(price)::text amount FROM trade_projections WHERE ${ordersWhere} GROUP BY status ORDER BY count(*) DESC,status`,
        values,
      )
    ).rows;
    const licenses = (
      await sql.query(
        `SELECT document->>'license_type' type,count(*)::text count,sum(price)::text amount FROM trade_projections WHERE ${ordersWhere} GROUP BY document->>'license_type' ORDER BY count(*) DESC,type`,
        values,
      )
    ).rows;
    const topAssets = (
      await sql.query(
        `SELECT t.asset_id,max(t.document->>'asset_title') title,sum(-e.amount::numeric)::text amount,count(DISTINCT j.id)::text count
      FROM journal_transactions j JOIN journal_entries e ON e.application_id=j.application_id AND e.transaction_id=j.id
      JOIN trade_projections t ON t.application_id=j.application_id AND t.id=j.reference_id
      WHERE j.application_id=$1 AND j.kind='settle' AND e.role='escrow' AND j.occurred_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND j.occurred_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
      GROUP BY t.asset_id ORDER BY sum(-e.amount::numeric) DESC,t.asset_id LIMIT 6`,
        values,
      )
    ).rows;
    const balances = (
      await sql.query(
        "SELECT kind,sum(balance)::text balance FROM account_projections WHERE application_id=$1 AND kind IN ('escrow','license_escrow','generation_hold','lookup_hold','user') GROUP BY kind ORDER BY kind",
        [app],
      )
    ).rows;
    const application = (
      await sql.query(
        "SELECT id,last_applied_at FROM applications WHERE id=$1",
        [app],
      )
    ).rows[0];
    return {
      application,
      range: { from, to, days, bucket_days: bucketDays },
      totals,
      comparison,
      orders,
      statuses,
      licenses,
      top_assets: topAssets,
      balances,
      trend,
      unit: "CREDIT",
      payment_mode: "simulated",
      timezone: "Asia/Shanghai",
      basis:
        "成交、退款、分账和作品排行按记账时间统计；订单状态及许可类型按下单时间筛选，展示这些订单当前状态；账户余额为当前同步时点，不受日期筛选影响。对比期为紧邻此前的等长时段，全部时间不作环比。",
    };
  });
}
