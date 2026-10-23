/** Aggregate integers are decimal strings; totals may exceed a single BIGINT. */
export type FinancialTotals = {
  settled: string;
  refunded: string;
  fees: string;
  royalties: string;
  seller_income: string;
  creator_royalties: string;
  upstream_royalties: string;
  settled_count: string;
  refund_count: string;
};
export type TrendPoint = FinancialTotals & {
  day: string;
  to: string;
  orders: string;
  amount: string;
};
export type Overview = {
  application: { id: string; last_applied_at: string | null };
  range: { from: string; to: string; days: number; bucket_days: number };
  totals: FinancialTotals;
  comparison: { from: string; to: string; totals: FinancialTotals } | null;
  orders: { count: string; amount: string; buyers: string; sellers: string };
  statuses: { status: string; count: string; amount: string }[];
  licenses: { type: string; count: string; amount: string }[];
  top_assets: {
    asset_id: string;
    title: string;
    amount: string;
    count: string;
  }[];
  balances: { kind: string; balance: string }[];
  trend: TrendPoint[];
  unit: "CREDIT";
  payment_mode: "simulated";
  timezone: "Asia/Shanghai";
  basis: string;
};
