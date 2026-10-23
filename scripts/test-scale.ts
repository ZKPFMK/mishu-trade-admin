import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { createGunzip } from "node:zlib";
import readline from "node:readline";
import { fixture } from "../tests/helpers.js";
import { queueJob } from "../packages/core/src/sync.js";
import { runJob } from "../packages/core/src/worker.js";
import { listData, filtersSchema } from "../packages/core/src/queries.js";
import { ROOT } from "../packages/core/src/config.js";
const f = await fixture(1),
  started = performance.now(),
  report: any = {
    created_at: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpu: os.cpus()[0]?.model,
    logical_cpus: os.cpus().length,
    memory_gib: Math.round(os.totalmem() / 1024 ** 3),
    scope:
      "Projection query and JSONL export benchmark only. Does not certify large-source snapshot import.",
    orders: 100000,
    journal_entries: 1000000,
  };
let peak = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 100);
try {
  console.log(
    "Seeding isolated benchmark schema: 100,000 orders and 1,000,000 entries.",
  );
  await f.db.query(
    `INSERT INTO trade_projections SELECT $1,'scale_'||lpad(g::text,8,'0'),1,'FUNDED','scale_buyer','scale_seller','scale_asset_'||g,1000,'2026-01-01'::timestamptz+g*interval '1 second','2026-01-01'::timestamptz+g*interval '1 second',jsonb_build_object('id','scale_'||lpad(g::text,8,'0'),'version','1','status','FUNDED','buyer_id','scale_buyer','seller_id','scale_seller','asset_id','scale_asset_'||g,'asset_title',repeat('长字段分账素材',60),'price','1000','unit','CREDIT','payment_mode','simulated','license_type','ownership','created_at',to_char('2026-01-01'::timestamptz+g*interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'updated_at','2026-01-01T00:00:00Z','settled_at',null,'refunded_at',null,'delivery_verified',false,'timeline','[]'::jsonb) FROM generate_series(1,100000) g`,
    [f.app],
  );
  await f.db.query(
    `INSERT INTO account_projections SELECT $1,'scale_account_'||i,1,NULL,'external',0,0,jsonb_build_object('id','scale_account_'||i,'version','1','owner_id',null,'kind','external','balance','0','opening_balance','0','unit','CREDIT') FROM generate_series(1,10) i`,
    [f.app],
  );
  // Ten postings per settlement: escrow, seller, fee, original creator and six upstream recipients.
  await f.db.query(
    `INSERT INTO journal_transactions SELECT $1,'scale_tx_'||lpad(g::text,8,'0'),'settle','scale_'||lpad(g::text,8,'0'),'2026-01-01'::timestamptz+g*interval '1 second','benchmark-only',jsonb_build_object('id','scale_tx_'||lpad(g::text,8,'0'),'kind','settle','reference_id','scale_'||lpad(g::text,8,'0'),'unit','CREDIT','payment_mode','simulated','occurred_at',to_char('2026-01-01'::timestamptz+g*interval '1 second','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'rule_version','scale-v1','entries',(SELECT jsonb_agg(jsonb_build_object('id','scale_entry_'||g||'_'||i,'account_id','scale_account_'||i,'amount',(CASE WHEN i=1 THEN -1000 WHEN i=2 THEN 800 WHEN i=3 THEN 40 WHEN i=4 THEN 40 ELSE 20 END)::text,'role',CASE WHEN i=1 THEN 'escrow' WHEN i=2 THEN 'seller' WHEN i=3 THEN 'fee' WHEN i=4 THEN 'creator_royalty' ELSE 'upstream_royalty' END)) FROM generate_series(1,10) i)) FROM generate_series(1,100000) g`,
    [f.app],
  );
  await f.db.query(
    `INSERT INTO journal_entries SELECT $1,'scale_entry_'||g||'_'||i,'scale_tx_'||lpad(g::text,8,'0'),'scale_account_'||i,CASE WHEN i=1 THEN -1000 WHEN i=2 THEN 800 WHEN i=3 THEN 40 WHEN i=4 THEN 40 ELSE 20 END,CASE WHEN i=1 THEN 'escrow' WHEN i=2 THEN 'seller' WHEN i=3 THEN 'fee' WHEN i=4 THEN 'creator_royalty' ELSE 'upstream_royalty' END FROM generate_series(1,100000) g CROSS JOIN generate_series(1,10) i`,
    [f.app],
  );
  await f.db.query("ANALYZE");
  report.seed_seconds = Number(
    ((performance.now() - started) / 1000).toFixed(2),
  );
  report.query_ms = {};
  for (const [name, filter] of [
    ["first", {}],
    ["jump_1000", { page: 1000 }],
    ["exact", { q: "scale_00050000" }],
    ["date", { from: "2026-01-01", to: "2026-01-01" }],
  ] as const) {
    const start = performance.now(),
      result = await listData(
        f.db,
        f.app,
        "trades",
        filtersSchema.parse(filter),
      );
    report.query_ms[name] = Number((performance.now() - start).toFixed(2));
    assert.ok(result.items.length > 0);
  }
  const first = await listData(f.db, f.app, "trades", filtersSchema.parse({})),
    start = performance.now();
  await listData(
    f.db,
    f.app,
    "trades",
    filtersSchema.parse({ cursor: first.next_cursor }),
  );
  report.query_ms.next_cursor = Number((performance.now() - start).toFixed(2));
  console.log(
    "Query benchmark complete; exporting one million balanced settlement entries.",
  );
  const job = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "settlements",
      format: "jsonl.gz",
      filters: { from: "2026-01-01", to: "2026-01-02" },
    }),
    exportStart = performance.now();
  await runJob(f.db, f.cfg, ["export"]);
  const result = (await f.db.query("SELECT * FROM jobs WHERE id=$1", [job]))
    .rows[0];
  assert.equal(result.state, "succeeded", result.error);
  assert.equal(result.progress, "1000000");
  assert.equal(result.result.parts.length, 20);
  report.export_seconds = Number(
    ((performance.now() - exportStart) / 1000).toFixed(2),
  );
  report.parts = result.result.parts.length;
  report.compressed_bytes = result.result.parts.reduce(
    (n: number, p: any) => n + p.bytes,
    0,
  );
  let lines = 0;
  for (const part of result.result.parts) {
    const input = fs
      .createReadStream(
        path.join(f.cfg.dataDir, result.result.directory, part.name),
      )
      .pipe(createGunzip());
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    let rows = 0;
    for await (const line of reader) {
      const row = JSON.parse(line);
      assert.equal(row["支付模式"], "simulated");
      assert.equal(row["计量单位"], "CREDIT");
      assert.equal(typeof row["分录金额"], "string");
      rows++;
      lines++;
    }
    assert.equal(rows, part.rows);
  }
  assert.equal(lines, 1000000);
  report.verified_rows = lines;
  report.peak_process_rss_mib = Math.round(peak / 1024 ** 2);
  report.database_bytes = (
    await f.db.query(
      "SELECT sum(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)))::text bytes FROM pg_tables WHERE schemaname=$1",
      [f.schema],
    )
  ).rows[0].bytes;
  console.log(
    "Compressed export verified. Testing forced XLSX with 100,000 long-detail orders.",
  );
  const xlsxJob = await queueJob(f.db, f.app, "requester", "export", {
      dataset: "trades",
      format: "xlsx",
      fields: "detail",
      filters: { from: "2026-01-01", to: "2026-01-02" },
    }),
    xlsxStart = performance.now();
  await runJob(f.db, f.cfg, ["export"]);
  const xlsx = (await f.db.query("SELECT * FROM jobs WHERE id=$1", [xlsxJob]))
    .rows[0];
  assert.equal(xlsx.state, "succeeded", xlsx.error);
  assert.equal(xlsx.progress, "100000");
  assert.ok(xlsx.result.parts.length >= 2);
  report.xlsx_seconds = Number(
    ((performance.now() - xlsxStart) / 1000).toFixed(2),
  );
  report.xlsx_parts = xlsx.result.parts.length;
  report.xlsx_bytes = xlsx.result.parts.reduce(
    (n: number, p: any) => n + p.bytes,
    0,
  );
  const { default: ExcelJS } = await import("exceljs");
  let xlsxRows = 0;
  for (const part of xlsx.result.parts) {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(
      path.join(f.cfg.dataDir, xlsx.result.directory, part.name),
      {
        worksheets: "emit",
        sharedStrings: "cache",
        styles: "ignore",
        hyperlinks: "ignore",
      },
    );
    for await (const sheet of workbook)
      for await (const row of sheet) {
        if (row.number === 1) continue;
        assert.equal(row.getCell(13).value, "1000");
        xlsxRows++;
      }
  }
  assert.equal(xlsxRows, 100000);
  report.xlsx_verified_rows = xlsxRows;
  report.peak_process_rss_mib = Math.round(peak / 1024 ** 2);
  const directory = path.join(ROOT, ".local/benchmarks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, "scale.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(sampler);
  await f.close();
}
