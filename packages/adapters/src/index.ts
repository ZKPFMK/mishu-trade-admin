import type pg from "pg";
import { z } from "zod";
import {
  snapshotSchema,
  eventSchema,
  tradeSchema,
  type Snapshot,
  type Trade,
  type Receipt,
  type Command,
} from "../../contracts/src/index.js";
import type { Config } from "../../core/src/config.js";
import { digest, id, insist } from "../../core/src/security.js";
import { executeMock } from "./mock.js";
const pageSchema = z.object({
  from_cursor: z.string().nullable(),
  through_cursor: z.string().nullable(),
  has_more: z.boolean(),
  events: z.array(eventSchema).max(100),
});
export function sourceAdapter(
  db: pg.Pool,
  cfg: Config,
  app: { id: string; source_mode: string },
) {
  async function http(path: string, body?: unknown) {
    insist(cfg.sourceUrl && cfg.sourceReadToken, 503, "source_not_configured");
    const base = new URL(cfg.sourceUrl);
    insist(
      base.protocol === "https:" ||
        (base.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)),
      503,
      "source_requires_https",
    );
    const response = await fetch(new URL(path, base), {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${cfg.sourceReadToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    insist(response.ok, 502, "source_http_" + response.status);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body as any) {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        await response.body?.cancel().catch(() => {});
        throw new Error("source_response_too_large");
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return {
    async snapshot(): Promise<Snapshot> {
      if (app.source_mode !== "mock") {
        const job = z
          .object({ snapshot_id: z.string().regex(/^[a-zA-Z0-9_.:-]+$/) })
          .parse(await http("/internal/trade-admin/snapshots", {}));
        return snapshotSchema.parse(
          await http(
            "/internal/trade-admin/snapshots/" +
              encodeURIComponent(job.snapshot_id),
          ),
        );
      }
      const s = (
        await db.query("SELECT * FROM mock_sources WHERE application_id=$1", [
          app.id,
        ])
      ).rows[0];
      insist(s, 404, "source_not_found");
      return {
        schema_version: 1,
        snapshot_id: id("snapshot"),
        cursor: s.cursor,
        created_at: new Date().toISOString(),
        history: "full",
        bundle: s.bundle,
        checksum: digest(s.bundle),
      };
    },
    async events(after: string | null) {
      if (app.source_mode !== "mock")
        return pageSchema.parse(
          await http(
            "/internal/trade-admin/events?after=" +
              encodeURIComponent(after || ""),
          ),
        );
      const all = (
        await db.query(
          "SELECT body FROM mock_events WHERE application_id=$1 ORDER BY seq",
          [app.id],
        )
      ).rows.map((r) => r.body);
      const index = all.findIndex((e) => e.previous_cursor === after);
      const events = index === -1 ? [] : all.slice(index, index + 100);
      const s = (
        await db.query(
          "SELECT cursor FROM mock_sources WHERE application_id=$1",
          [app.id],
        )
      ).rows[0];
      insist(index !== -1 || s?.cursor === after, 409, "cursor_expired");
      return {
        from_cursor: after,
        through_cursor: events.at(-1)?.source_cursor ?? after,
        has_more: index >= 0 && index + 100 < all.length,
        events,
      };
    },
    async trade(key: string): Promise<Trade> {
      if (app.source_mode !== "mock")
        return tradeSchema.parse(
          await http("/internal/trade-admin/trades/" + encodeURIComponent(key)),
        );
      const s = (
        await db.query(
          "SELECT bundle FROM mock_sources WHERE application_id=$1",
          [app.id],
        )
      ).rows[0];
      const t = s?.bundle.trades.find((t: Trade) => t.id === key);
      insist(t, 404, "trade_not_found");
      return t;
    },
    async receipt(commandId: string): Promise<Receipt | null> {
      insist(app.source_mode === "mock", 403, "real_source_commands_disabled");
      return (
        (
          await db.query(
            "SELECT receipt FROM mock_commands WHERE application_id=$1 AND command_id=$2",
            [app.id, commandId],
          )
        ).rows[0]?.receipt || null
      );
    },
    async execute(command: Command): Promise<Receipt> {
      insist(app.source_mode === "mock", 403, "real_source_commands_disabled");
      return executeMock(db, app.id, command);
    },
  };
}
