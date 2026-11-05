import type pg from "pg";
import { z } from "zod";
import { identifier } from "../../contracts/src/index.js";
import { insist } from "./security.js";

export const assetFilters = z
  .object({
    q: z.string().trim().max(160).default(""),
    status: z.string().max(60).default(""),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(
    (f) => !f.from || !f.to || f.from <= f.to,
    "Start date must not be after end date",
  );

const assetSelect = `
  t.asset_id,
  max(t.document->>'asset_title') AS title,
  max(t.updated_at) AS last_seen_at,
  min(t.created_at) AS first_seen_at,
  max((t.document->>'version')::bigint)::text AS latest_version,
  count(*)::text AS order_count,
  count(*) FILTER (WHERE t.document->>'delivery_verified'='true')::text AS delivered_count,
  count(*) FILTER (WHERE t.status IN ('COMPLETED','RESOLVED_SELLER'))::text AS completed_count,
  COALESCE(array_agg(DISTINCT t.document->>'license_type' ORDER BY t.document->>'license_type') FILTER (WHERE t.document->>'license_type' IS NOT NULL),'{}') AS license_types`;

export type AssetFilters = z.infer<typeof assetFilters>;

export async function listAssets(db: pg.Pool, app: string, f: AssetFilters) {
  const values = [
      app,
      f.q || null,
      f.status || null,
      f.from || null,
      f.to || null,
    ],
    where = [
      "t.application_id=$1",
      "($2::text IS NULL OR strpos(lower(t.asset_id),lower($2))>0 OR strpos(lower(t.document->>'asset_title'),lower($2))>0)",
      "($3::text IS NULL OR t.status=$3)",
      "($4::date IS NULL OR t.created_at >= $4::date::timestamptz)",
      "($5::date IS NULL OR t.created_at < $5::date::timestamptz + interval '1 day')",
    ];
  const total = (
    await db.query(
      `SELECT count(DISTINCT t.asset_id)::text total FROM trade_projections t WHERE ${where.join(" AND ")}`,
      values,
    )
  ).rows[0].total;
  const rows = (
    await db.query(
      `SELECT ${assetSelect} FROM trade_projections t WHERE ${where.join(" AND ")} GROUP BY t.asset_id ORDER BY max(t.updated_at) DESC,t.asset_id DESC LIMIT $6 OFFSET $7`,
      [...values, f.limit + 1, (f.page - 1) * f.limit],
    )
  ).rows;
  const items = rows.slice(0, f.limit);
  return {
    items,
    total,
    page: f.page,
    limit: f.limit,
    next_cursor: null,
    max_jump_page: 1000,
  };
}

export async function assetDetail(db: pg.Pool, app: string, rawId: string) {
  const assetId = identifier.parse(rawId),
    asset = (
      await db.query(
        `SELECT ${assetSelect} FROM trade_projections t WHERE t.application_id=$1 AND t.asset_id=$2 GROUP BY t.asset_id`,
        [app, assetId],
      )
    ).rows[0];
  insist(asset, 404, "asset_not_found");
  const versions = (
      await db.query(
        `SELECT t.document->>'version' version,max(t.updated_at) last_seen_at,count(*)::text order_count,COALESCE(array_agg(DISTINCT t.document->>'license_type' ORDER BY t.document->>'license_type') FILTER (WHERE t.document->>'license_type' IS NOT NULL),'{}') license_types FROM trade_projections t WHERE t.application_id=$1 AND t.asset_id=$2 GROUP BY t.document->>'version' ORDER BY (t.document->>'version')::bigint DESC`,
        [app, assetId],
      )
    ).rows,
    orders = (
      await db.query(
        "SELECT t.document FROM trade_projections t WHERE t.application_id=$1 AND t.asset_id=$2 ORDER BY t.created_at DESC,t.id DESC LIMIT 100",
        [app, assetId],
      )
    ).rows.map((r) => r.document);
  return {
    asset,
    versions,
    orders,
    evidence: {
      source: "trade_projections",
      authority: "source_service",
      note: "资产、版本和授权摘要来自订单投影；购买、所有权、账本和真实授权仍以来源服务为准。",
    },
  };
}
