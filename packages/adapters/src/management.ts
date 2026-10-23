import {
  managementPreview,
  managementReceipt,
  type ManagementInput,
  type ManagementCommand,
} from "../../contracts/src/management.js";
import type { Config } from "../../core/src/config.js";
import { digest, insist, TradeError } from "../../core/src/security.js";

export function managementAdapter(cfg: Config) {
  async function http(route: string, body?: unknown, write = false) {
    const token = write ? cfg.sourceCommandToken : cfg.sourceReadToken;
    insist(cfg.sourceUrl && token, 503, "management_not_configured");
    const base = new URL(cfg.sourceUrl);
    insist(
      base.protocol === "https:" ||
        (base.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)),
      503,
      "source_requires_https",
    );
    const response = await fetch(
      new URL("/internal/trade-admin/management/" + route, base),
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization: "Bearer " + token,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader)
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          chunks.push(value);
          if (bytes > 128 * 1024) throw Error("source_response_too_large");
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    const text = Buffer.concat(chunks).toString("utf8");
    // A transport error is not a business rejection. The worker must recover the original receipt.
    if (!response.ok) {
      if (route === "preview") {
        let code = "source_unavailable";
        try {
          code = JSON.parse(text).error || code;
        } catch {}
        throw new TradeError(response.status < 500 ? 409 : 503, code);
      }
      throw Error("source_result_unknown");
    }
    return JSON.parse(text);
  }
  function verified(raw: unknown, command: ManagementCommand) {
    const receipt = managementReceipt.parse(raw);
    insist(
      receipt.command_id === command.intent.command_id &&
        receipt.source_id === command.intent.source_id &&
        receipt.request_digest === digest(command.intent) &&
        receipt.target_id === command.intent.operation.target_id &&
        receipt.type === command.intent.operation.type,
      502,
      "invalid_source_receipt",
    );
    return receipt;
  }
  return {
    async preview(input: ManagementInput) {
      return managementPreview.parse(await http("preview", input));
    },
    async receipt(command: ManagementCommand) {
      const r = await http(
        "receipts/" + encodeURIComponent(command.intent.command_id),
      );
      return r.receipt ? verified(r.receipt, command) : null;
    },
    async execute(command: ManagementCommand) {
      return verified(await http("commands", command, true), command);
    },
    async cancel(command: ManagementCommand) {
      return verified(await http("cancel", command, true), command);
    },
  };
}
