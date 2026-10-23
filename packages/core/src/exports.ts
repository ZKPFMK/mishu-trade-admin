import type pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import ExcelJS from "exceljs";
import { z } from "zod";
import {
  datasets,
  filtersSchema,
  listData,
  querySpec,
  type Dataset,
} from "./queries.js";
import { insist, TradeError } from "./security.js";
import type { Config } from "./config.js";
export const exportSchema = z
  .object({
    dataset: z.enum(datasets),
    format: z.enum(["auto", "xlsx", "jsonl.gz"]).default("auto"),
    scope: z.enum(["filtered", "page"]).default("filtered"),
    fields: z.enum(["summary", "detail"]).default("summary"),
    filters: filtersSchema.default({ q: "", status: "", page: 1, limit: 25 }),
  })
  .strict();
const headers = [
  "应用",
  "环境",
  "计量单位",
  "支付模式",
  "同步截止游标",
  "数据类型",
  "编号",
  "时间",
  "状态或类型",
  "用户或买家",
  "卖家",
  "资产或关联编号",
  "金额或余额",
  "分录编号",
  "账户",
  "分录金额",
  "分账类型",
  "明细JSON",
];
function rows(
  dataset: Dataset,
  d: any,
  meta: string[],
  detail: boolean,
): string[][] {
  const base = [
    ...meta,
    dataset,
    d.id,
    d.created_at || d.occurred_at || d.updated_at || "",
    d.status || d.kind || "",
    d.buyer_id || d.owner_id || d.user_id || "",
    d.seller_id || "",
    d.asset_id || d.reference_id || "",
    d.price || d.balance || d.charged || "",
  ];
  if (d.entries)
    return d.entries.map((e: any) => [
      ...base,
      e.id,
      e.account_id,
      e.amount,
      e.role,
      detail ? JSON.stringify({ rule_version: d.rule_version }) : "",
    ]);
  return [[...base, "", "", "", "", detail ? JSON.stringify(d) : ""]];
}
export async function exportJob(
  db: pg.Pool,
  cfg: Config,
  job: any,
  lease: string,
) {
  const settings = exportSchema.parse(job.payload),
    dir = path.join(cfg.dataDir, "exports", job.id, lease);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const client = await db.connect();
  let writer: ExcelJS.stream.xlsx.WorkbookWriter | undefined,
    sheet: ExcelJS.Worksheet | undefined,
    gzip: ReturnType<typeof createGzip> | undefined,
    compressed: Promise<void> | undefined;
  const parts: { name: string; rows: number; bytes: number }[] = [];
  let partRows = 0,
    partBytes = 0,
    totalBytes = 0,
    totalRows = 0,
    name = "",
    format: string = "xlsx",
    closed = false;
  async function closePart() {
    if (writer) {
      sheet!.commit();
      await writer.commit();
      writer = undefined;
      sheet = undefined;
    }
    if (gzip) {
      gzip.end();
      await compressed;
      gzip = undefined;
    }
    if (name)
      parts.push({
        name,
        rows: partRows,
        bytes: fs.statSync(path.join(dir, name)).size,
      });
  }
  async function openPart() {
    name = `${settings.dataset}-${String(parts.length + 1).padStart(3, "0")}.${format}`;
    partRows = 0;
    partBytes = 0;
    if (format === "xlsx") {
      writer = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: path.join(dir, name),
        useSharedStrings: false,
        useStyles: false,
      });
      sheet = writer.addWorksheet("交易记录");
      sheet.addRow(headers).commit();
    } else {
      gzip = createGzip();
      compressed = pipeline(
        gzip,
        fs.createWriteStream(path.join(dir, name), { mode: 0o600 }),
      );
      void compressed.catch(() => {});
    }
  }
  async function alive() {
    const r = (
      await db.query(
        "SELECT cancel_requested,lease_token,expires_at FROM jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    insist(
      r?.lease_token === lease && !r.cancel_requested,
      409,
      "export_canceled",
    );
    const permitted = (
      await db.query(
        "SELECT 1 FROM operators o JOIN operator_scopes s ON s.operator_id=o.id WHERE o.id=$1 AND s.application_id=$2 AND o.enabled AND (o.roles && $3::text[])",
        [
          job.owner_id,
          job.application_id,
          ["viewer", "operator", "approver", "auditor", "admin"],
        ],
      )
    ).rowCount;
    insist(permitted, 403, "export_permission_revoked");
    await db.query(
      "UPDATE jobs SET progress=$2,updated_at=now() WHERE id=$1 AND lease_token=$3",
      [job.id, totalRows, lease],
    );
  }
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const app = (
      await client.query("SELECT * FROM applications WHERE id=$1", [
        job.application_id,
      ])
    ).rows[0];
    insist(app.initialized, 409, "source_not_initialized");
    const meta = [
      app.name,
      app.environment,
      "CREDIT",
      "simulated",
      app.applied_cursor || "initial",
    ];
    let filters = {
      ...settings.filters,
      limit: settings.scope === "page" ? settings.filters.limit : 100,
      page: settings.scope === "page" ? settings.filters.page : 1,
      cursor: settings.scope === "page" ? settings.filters.cursor : undefined,
    };
    let page = await listData(client, app.id, settings.dataset, filters);
    let estimatedRows = BigInt(page.total);
    if (settings.scope === "page")
      estimatedRows = BigInt(
        page.items.reduce((n, r) => n + (r.entries?.length || 1), 0),
      );
    else if (
      ["journal-transactions", "settlements"].includes(settings.dataset) &&
      settings.format === "auto"
    ) {
      const spec = querySpec(app.id, settings.dataset, filters);
      estimatedRows = BigInt(
        (
          await client.query(
            `SELECT count(*)::text n FROM journal_transactions t JOIN journal_entries e ON e.application_id=t.application_id AND e.transaction_id=t.id WHERE ${spec.baseWhere}`,
            spec.baseValues,
          )
        ).rows[0].n,
      );
    }
    format =
      settings.format === "auto"
        ? estimatedRows > 100000n
          ? "jsonl.gz"
          : "xlsx"
        : settings.format;
    if (
      settings.format === "auto" &&
      format === "xlsx" &&
      settings.fields === "detail"
    ) {
      const spec = querySpec(app.id, settings.dataset, filters);
      const long =
        settings.scope === "page"
          ? page.items.some((r) => JSON.stringify(r).length > 32000)
          : (
              await client.query(
                `SELECT 1 FROM ${spec.table} t WHERE ${spec.baseWhere} AND length(t.document::text)>32000 LIMIT 1`,
                spec.baseValues,
              )
            ).rowCount;
      if (long) format = "jsonl.gz";
    }
    await openPart();
    while (true) {
      await alive();
      for (const record of page.items)
        for (const row of rows(
          settings.dataset,
          record,
          meta,
          settings.fields === "detail",
        )) {
          const encoded =
            format === "jsonl.gz"
              ? JSON.stringify(
                  Object.fromEntries(headers.map((h, i) => [h, row[i]])),
                ) + "\n"
              : JSON.stringify(row);
          const bytes = Buffer.byteLength(encoded);
          if (partRows >= 50000 || partBytes + bytes > 32 * 1024 * 1024) {
            await closePart();
            await openPart();
          }
          totalBytes += bytes;
          insist(
            totalBytes <= 2 * 1024 * 1024 * 1024,
            413,
            "export_size_limit",
          );
          if (sheet) {
            insist(
              row.every((cell) => cell.length <= 32767),
              413,
              "excel_cell_limit",
            );
            sheet.addRow(row).commit();
          } else if (!gzip!.write(encoded)) await once(gzip!, "drain");
          totalRows++;
          partRows++;
          partBytes += bytes;
          if (totalRows % 1000 === 0) await alive();
        }
      if (settings.scope === "page" || !page.next_cursor) break;
      filters = { ...filters, cursor: page.next_cursor };
      page = await listData(client, app.id, settings.dataset, filters, false);
    }
    await closePart();
    await alive();
    insist(
      parts.reduce((n, p) => n + p.bytes, 0) <= 2 * 1024 * 1024 * 1024,
      413,
      "export_size_limit",
    );
    await client.query("COMMIT");
    closed = true;
    const result = {
      format,
      rows: totalRows,
      parts,
      directory: path.relative(cfg.dataDir, dir),
      cursor: app.applied_cursor,
      cutoff_at: app.last_applied_at,
      unit: "CREDIT",
      payment_mode: "simulated",
      environment: app.environment,
    };
    const saved = await db.query(
      "UPDATE jobs SET state='succeeded',result=$2,progress=$3,expires_at=now()+interval '24 hours',lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$4 AND NOT cancel_requested",
      [job.id, JSON.stringify(result), totalRows, lease],
    );
    insist(saved.rowCount, 409, "export_canceled");
    return result;
  } catch (e) {
    gzip?.destroy();
    if (compressed) await compressed.catch(() => {});
    if (writer) await writer.commit().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  } finally {
    if (!closed) await client.query("ROLLBACK");
    client.release();
  }
}
export async function cleanupExports(db: pg.Pool, cfg: Config) {
  const expired = (
    await db.query(
      "UPDATE jobs SET state='expired',updated_at=now() WHERE kind='export' AND state='succeeded' AND expires_at<now() RETURNING id",
    )
  ).rows;
  for (const j of expired)
    fs.rmSync(path.join(cfg.dataDir, "exports", j.id), {
      recursive: true,
      force: true,
    });
  const abandoned = (
    await db.query(
      "SELECT id FROM jobs WHERE kind='export' AND state IN ('failed','canceled','expired') AND updated_at<now()-interval '24 hours'",
    )
  ).rows;
  for (const j of abandoned)
    fs.rmSync(path.join(cfg.dataDir, "exports", j.id), {
      recursive: true,
      force: true,
    });
}
