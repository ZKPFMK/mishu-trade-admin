import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { demoBundle } from "../packages/adapters/src/mock.js";
import { importSnapshot } from "../packages/core/src/sync.js";
import { digest } from "../packages/core/src/security.js";
import type { Overview } from "../packages/contracts/src/analytics.js";

test("analytics preserves exact amounts, Shanghai boundaries and separate order/settlement cohorts", async () => {
  const f = await fixture(0),
    app = "analytics_test",
    huge = 9007199254740993n;
  try {
    const bundle = demoBundle(8);
    for (const t of bundle.trades)
      t.created_at =
        t.id === "trade_00004"
          ? "2026-05-01T15:59:59.999Z"
          : "2026-05-01T16:00:00.000Z";
    for (const j of bundle.journals) {
      if (j.kind === "fund" || j.kind === "settle")
        j.occurred_at = "2026-05-01T16:00:00.000Z";
      if (j.kind === "settle" && j.reference_id === "trade_00004")
        j.occurred_at = "2026-05-02T15:59:59.999Z";
      if (j.kind === "refund")
        j.occurred_at =
          j.reference_id === "trade_00003"
            ? "2026-05-02T16:00:00.000Z"
            : "2026-05-01T15:59:59.999Z";
      if (
        j.kind === "topup" &&
        j.entries.some((e) => e.account_id === "user:buyer3")
      )
        for (const e of j.entries)
          e.amount = String(e.role === "buyer" ? huge * 2n : -huge * 2n);
      if (j.reference_id === "trade_00002")
        for (const e of j.entries) {
          if (j.kind === "fund")
            e.amount = String(e.role === "buyer" ? -huge : huge);
          if (j.kind === "settle" && e.role === "escrow")
            e.amount = String(-huge);
          if (j.kind === "settle" && e.role === "seller")
            e.amount = String(huge - 20n);
        }
    }
    bundle.trades.find((t) => t.id === "trade_00002")!.price = String(huge);
    // Retain a valid, balanced full snapshot while exercising values larger than JS safe integers.
    for (const a of bundle.accounts)
      a.balance = String(
        bundle.journals.reduce(
          (n, j) =>
            n +
            j.entries
              .filter((e) => e.account_id === a.id)
              .reduce((v, e) => v + BigInt(e.amount), 0n),
          0n,
        ),
      );
    await f.db.query(
      "INSERT INTO applications(id,name,environment,source_mode) VALUES($1,$1,'test','mock')",
      [app],
    );
    await f.db.query("INSERT INTO operator_scopes VALUES($1,$2)", [
      "requester",
      app,
    ]);
    await importSnapshot(f.db, app, {
      schema_version: 1,
      snapshot_id: "analytics_snapshot",
      cursor: "analytics_start",
      created_at: new Date().toISOString(),
      history: "full",
      bundle,
      checksum: digest(bundle),
    });
    const headers = await f.session("requester");
    async function get(query: string) {
      const r = await f.api.inject({
        url: "/admin/overview?application_id=" + app + query,
        headers,
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json() as Overview;
    }
    const d = await get("&from=2026-05-02&to=2026-05-02");
    assert.equal(d.totals.settled, String(huge + 228n));
    assert.equal(d.totals.settled_count, "2");
    assert.equal(d.totals.refunded, "0");
    assert.equal(d.totals.fees, "12");
    assert.equal(d.totals.royalties, "29");
    assert.equal(d.totals.seller_income, String(huge + 187n));
    assert.deepEqual(d.orders, {
      count: "7",
      amount: String(huge + 1410n),
      buyers: "7",
      sellers: "5",
    });
    assert.ok(!d.statuses.some((s) => s.status === "RESOLVED_SELLER"));
    assert.equal(
      d.statuses.find((s) => s.status === "COMPLETED")!.amount,
      String(huge),
    );
    assert.deepEqual(
      d.licenses.map((l) => ({ type: l.type, count: l.count })),
      [
        { type: "ownership", count: "5" },
        { type: "license", count: "2" },
      ],
    );
    assert.deepEqual(
      d.top_assets.map((a) => [a.asset_id, a.amount]),
      [
        ["asset_2", String(huge)],
        ["asset_4", "228"],
      ],
    );
    assert.equal(d.comparison!.from, "2026-05-01");
    assert.equal(d.comparison!.to, "2026-05-01");
    assert.equal(d.comparison!.totals.refunded, "249");
    assert.equal(d.comparison!.totals.settled, "0");
    assert.equal(d.trend.length, 1);
    assert.equal(d.trend[0].orders, "7");
    assert.equal(d.trend[0].settled, String(huge + 228n));

    const continuous = await get("&from=2026-05-02&to=2026-05-04");
    assert.deepEqual(
      continuous.trend.map((p) => [p.day, p.refunded]),
      [
        ["2026-05-02", "0"],
        ["2026-05-03", "221"],
        ["2026-05-04", "0"],
      ],
    );
    assert.equal(continuous.trend[2].settled, "0");
    assert.equal(continuous.trend[2].orders, "0");
    const empty = await get("&from=2040-02-01&to=2040-02-07");
    assert.equal(empty.orders.count, "0");
    assert.equal(empty.totals.settled, "0");
    assert.deepEqual(empty.statuses, []);
    assert.deepEqual(empty.top_assets, []);
    assert.equal(empty.trend.length, 7);
    assert.deepEqual(
      empty.balances,
      d.balances,
      "stock balances do not change with activity date filters",
    );
    assert.equal(
      empty.balances.find((b) => b.kind === "escrow")!.balance,
      "940",
    );

    const long = await get("&from=2020-01-01&to=2030-12-31");
    assert.ok(long.trend.length <= 90);
    assert.ok(long.range.bucket_days > 1);
    assert.equal(long.trend[0].day, "2020-01-01");
    assert.equal(long.trend.at(-1)!.to, "2030-12-31");
    assert.equal(
      long.trend.reduce((n, p) => n + BigInt(p.settled), 0n),
      huge + 228n,
    );
    assert.equal(long.totals.refunded, "470");
    const all = await get("");
    assert.equal(all.comparison, null);
    assert.ok(all.trend.length <= 90);
    assert.equal(all.orders.count, "8");
    const denied = await f.api.inject({
      url: "/admin/overview?application_id=" + app,
      headers: await f.session("outsider"),
    });
    assert.equal(denied.statusCode, 403);
    const other = await f.api.inject({
      url: "/admin/overview?application_id=" + f.app,
      headers,
    });
    assert.equal(other.json().orders.count, "0");
    assert.equal(other.json().totals.settled, "0");
    for (const query of ["&from=2026-02-30", "&from=2026-05-04&to=2026-05-02"])
      assert.equal(
        (
          await f.api.inject({
            url: "/admin/overview?application_id=" + app + query,
            headers,
          })
        ).statusCode,
        400,
      );
  } finally {
    await f.close();
  }
});
