import type pg from "pg";
import { transaction } from "../../database/src/index.js";
import {
  commandSchema,
  type Bundle,
  type Journal,
  type Trade,
  type SourceEvent,
  type Command,
  type Receipt,
} from "../../contracts/src/index.js";
import { digest, id, insist } from "../../core/src/security.js";

export function demoBundle(count = 128): Bundle {
  const b: Bundle = { trades: [], accounts: [], journals: [], jobs: [] };
  const account = (key: string) => {
    let a = b.accounts.find((a) => a.id === key);
    if (!a) {
      const p = key.split(":")[0];
      a = {
        id: key,
        version: "1",
        owner_id: p === "user" ? key.slice(5) : null,
        kind:
          p === "user"
            ? "user"
            : p === "escrow"
              ? "escrow"
              : p === "jobs"
                ? "generation_hold"
                : p === "platform"
                  ? "platform"
                  : "external",
        balance: "0",
        opening_balance: "0",
        unit: "CREDIT",
      };
      b.accounts.push(a);
    }
    return a;
  };
  const post = (
    kind: Journal["kind"],
    ref: string,
    at: string,
    entries: Array<[string, bigint, Journal["entries"][number]["role"]]>,
  ) => {
    const tx = id("tx");
    b.journals.push({
      id: tx,
      kind,
      reference_id: ref,
      unit: "CREDIT",
      payment_mode: "simulated",
      occurred_at: at,
      rule_version: kind === "settle" ? "mock-v1" : null,
      entries: entries.map(([key, amount, role], i) => ({
        id: `${tx}:${i}`,
        account_id: key,
        amount: String(amount),
        role,
      })),
    });
    for (const [key, amount] of entries) {
      const a = account(key);
      a.balance = String(BigInt(a.balance) + amount);
      a.version = String(BigInt(a.version) + 1n);
    }
  };
  const now = Date.now(),
    at = new Date(now - 32 * 86400000).toISOString();
  for (let i = 1; i <= 12; i++)
    post("topup", `pack:${i}`, at, [
      ["external:payments", -1000000n, "other"],
      [`user:buyer${i}`, 1000000n, "buyer"],
    ]);
  for (let i = 1; i <= count; i++) {
    const key = `trade_${String(i).padStart(5, "0")}`,
      buyer = `buyer${(i % 12) + 1}`,
      seller = `creator${(i % 6) + 1}`,
      price = BigInt(200 + i * 7),
      time = new Date(now - (count - i) * 18000000).toISOString();
    const state: Trade["status"] = (
      [
        "FUNDED",
        "DELIVERED",
        "COMPLETED",
        "REFUNDED",
        "RESOLVED_SELLER",
        "FUNDED",
        "DISPUTED",
        "RESOLVED_BUYER",
      ] as const
    )[i % 8];
    const t: Trade = {
      id: key,
      version: state === "FUNDED" ? "1" : state === "DELIVERED" ? "2" : "3",
      asset_id: `asset_${i}`,
      asset_title: [
        "光影森林 · 动态素材",
        "雨夜城市 · 概念短片",
        "山海之间 · 国风场景",
        "无声剧场 · 人物片段",
      ][i % 4],
      buyer_id: buyer,
      seller_id: seller,
      price: String(price),
      unit: "CREDIT",
      payment_mode: "simulated",
      status: state,
      license_type: i % 3 === 0 ? "license" : "ownership",
      created_at: time,
      updated_at: time,
      settled_at: null,
      refunded_at: null,
      delivery_verified: ["DELIVERED", "COMPLETED", "RESOLVED_SELLER"].includes(
        state,
      ),
      timeline: [
        { status: "FUNDED", at: time, note: "买家支付模拟积分，进入托管" },
      ],
    };
    post("fund", key, time, [
      [`user:${buyer}`, -price, "buyer"],
      [`escrow:${key}`, price, "escrow"],
    ]);
    if (["COMPLETED", "RESOLVED_SELLER"].includes(state)) {
      const fee = (price * 3n) / 100n,
        royalty = (price * 5n) / 100n,
        upstream = (price * 2n) / 100n;
      post("settle", key, time, [
        [`escrow:${key}`, -price, "escrow"],
        [`user:${seller}`, price - fee - royalty - upstream, "seller"],
        ["platform:fee", fee, "fee"],
        ["user:original", royalty, "creator_royalty"],
        ["user:upstream", upstream, "upstream_royalty"],
      ]);
      t.settled_at = time;
    }
    if (["REFUNDED", "RESOLVED_BUYER"].includes(state)) {
      post("refund", key, time, [
        [`escrow:${key}`, -price, "escrow"],
        [`user:${buyer}`, price, "buyer"],
      ]);
      t.refunded_at = time;
    }
    if (state !== "FUNDED")
      t.timeline.push({
        status: state,
        at: time,
        note: "演示来源的业务状态变化",
      });
    b.trades.push(t);
  }
  for (let i = 1; i <= 3; i++) {
    const key = `job_${i}`,
      buyer = "buyer1",
      held = 100n,
      charged = i === 2 ? 70n : 0n,
      state = i === 1 ? "held" : i === 2 ? "settled" : "refunded";
    post("generation_hold", key, at, [
      [`user:${buyer}`, -held, "buyer"],
      [`jobs:hold:${key}`, held, "generation"],
    ]);
    if (i !== 1)
      post(i === 2 ? "generation_settle" : "generation_refund", key, at, [
        [`jobs:hold:${key}`, -held, "generation"],
        [`user:${buyer}`, held - charged, "buyer"],
        ["platform:generation", charged, "generation"],
      ]);
    b.jobs.push({
      id: key,
      version: i === 1 ? "1" : "2",
      user_id: buyer,
      status: state,
      held: String(held),
      charged: String(charged),
      updated_at: at,
    });
  }
  return b;
}
export async function executeMock(
  db: pg.Pool,
  app: string,
  raw: Command,
): Promise<Receipt> {
  const command = commandSchema.parse(raw);
  return transaction(db, async (sql) => {
    const source = (
      await sql.query(
        "SELECT * FROM mock_sources WHERE application_id=$1 FOR UPDATE",
        [app],
      )
    ).rows[0];
    insist(source, 404, "mock_source_missing");
    const existing = (
      await sql.query(
        "SELECT * FROM mock_commands WHERE application_id=$1 AND command_id=$2",
        [app, command.command_id],
      )
    ).rows[0];
    if (existing) {
      insist(
        existing.digest === digest(command),
        409,
        "command_digest_conflict",
      );
      return existing.receipt;
    }
    const b = source.bundle as Bundle,
      t = b.trades.find((t) => t.id === command.trade_id);
    let code = !t
      ? "trade_not_found"
      : t.status !== "FUNDED"
        ? "trade_not_funded"
        : t.delivery_verified
          ? "trade_delivered"
          : t.version !== command.expected_version
            ? "stale_version"
            : t.price !== command.amount || t.buyer_id !== command.buyer_id
              ? "impact_changed"
              : "";
    const escrow = b.accounts.find((a) => a.id === `escrow:${t?.id}`),
      buyer = b.accounts.find((a) => a.id === `user:${t?.buyer_id}`);
    if (!code && (!escrow || !buyer || escrow.balance !== t!.price))
      code = "escrow_mismatch";
    const receipt: Receipt = {
      command_id: command.command_id,
      trade_id: command.trade_id,
      status: code ? "rejected" : "succeeded",
      code: code || "refunded",
      version: t?.version || "0",
    };
    if (!code && t && escrow && buyer) {
      const now = new Date().toISOString(),
        tx = id("tx"),
        eventId = id("evt"),
        cursor = id("cursor");
      for (const [a, amount] of [
        [escrow, -BigInt(t.price)],
        [buyer, BigInt(t.price)],
      ] as const) {
        a.balance = String(BigInt(a.balance) + amount);
        a.version = String(BigInt(a.version) + 1n);
      }
      t.status = "REFUNDED";
      t.version = String(BigInt(t.version) + 1n);
      t.updated_at = now;
      t.refunded_at = now;
      t.timeline.push({ status: "REFUNDED", at: now, note: command.reason });
      const j: Journal = {
        id: tx,
        kind: "refund",
        reference_id: t.id,
        unit: "CREDIT",
        payment_mode: "simulated",
        occurred_at: now,
        rule_version: "mock-refund-v1",
        entries: [
          {
            id: tx + ":0",
            account_id: escrow.id,
            amount: "-" + t.price,
            role: "escrow",
          },
          {
            id: tx + ":1",
            account_id: buyer.id,
            amount: t.price,
            role: "buyer",
          },
        ],
      };
      b.journals.push(j);
      const event: SourceEvent = {
        schema_version: 1,
        event_id: eventId,
        source_cursor: cursor,
        previous_cursor: source.cursor,
        occurred_at: now,
        bundle: {
          trades: [t],
          accounts: [escrow, buyer],
          journals: [j],
          jobs: [],
        },
      };
      await sql.query(
        "UPDATE mock_sources SET bundle=$2,cursor=$3 WHERE application_id=$1",
        [app, JSON.stringify(b), cursor],
      );
      await sql.query(
        "INSERT INTO mock_events(application_id,event_id,body) VALUES($1,$2,$3)",
        [app, eventId, JSON.stringify(event)],
      );
      receipt.version = t.version;
      receipt.journal_id = tx;
    }
    await sql.query("INSERT INTO mock_commands VALUES($1,$2,$3,$4)", [
      app,
      command.command_id,
      digest(command),
      JSON.stringify(receipt),
    ]);
    return receipt;
  });
}
