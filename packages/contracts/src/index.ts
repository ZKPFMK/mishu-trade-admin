import { z } from "zod";
export const identifier = z.string().regex(/^[a-zA-Z0-9_:.-]{1,160}$/);
const integerText = (v: string) => v.length <= 20 && /^(0|-?[1-9]\d*)$/.test(v);
export const integer = z
  .string()
  .max(20)
  .regex(/^(0|-?[1-9]\d*)$/)
  .refine(
    (v) =>
      integerText(v) &&
      BigInt(v) >= -9223372036854775808n &&
      BigInt(v) <= 9223372036854775807n,
    "Canonical BIGINT string required",
  )
  .describe(
    "Canonical signed 64-bit integer as decimal text; range is validated at runtime.",
  );
export const positive = integer
  .regex(/^[1-9]\d*$/)
  .refine((v) => integerText(v) && BigInt(v) > 0n);
export const version = positive;
const time = z.iso.datetime({ offset: true });
export const tradeStatus = z.enum([
  "FUNDED",
  "DELIVERED",
  "DISPUTED",
  "COMPLETED",
  "REFUNDED",
  "RESOLVED_BUYER",
  "RESOLVED_SELLER",
]);
export const tradeSchema = z
  .object({
    id: identifier,
    version,
    asset_id: identifier,
    asset_title: z.string().max(500),
    buyer_id: identifier,
    seller_id: identifier,
    price: positive,
    unit: z.literal("CREDIT"),
    payment_mode: z.literal("simulated"),
    status: tradeStatus,
    license_type: z.enum(["ownership", "license", "usage", "display"]),
    created_at: time,
    updated_at: time,
    settled_at: time.nullable(),
    refunded_at: time.nullable(),
    delivery_verified: z.boolean(),
    timeline: z
      .array(
        z
          .object({
            status: z.string().max(60),
            at: time,
            note: z.string().max(1000),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export const accountSchema = z
  .object({
    id: identifier,
    version,
    owner_id: identifier.nullable(),
    kind: z.enum([
      "user",
      "escrow",
      "license_escrow",
      "generation_hold",
      "lookup_hold",
      "platform",
      "external",
      "other",
    ]),
    balance: integer,
    opening_balance: integer,
    unit: z.literal("CREDIT"),
  })
  .strict();
export const entrySchema = z
  .object({
    id: identifier,
    account_id: identifier,
    amount: integer,
    source_kind: z.string().max(100).optional(),
    memo: z.string().max(8000).optional(),
    role: z.enum([
      "buyer",
      "seller",
      "fee",
      "creator_royalty",
      "upstream_royalty",
      "escrow",
      "generation",
      "other",
    ]),
  })
  .strict();
export const journalSchema = z
  .object({
    id: identifier,
    kind: z.enum([
      "topup",
      "grant",
      "fund",
      "settle",
      "refund",
      "generation_hold",
      "generation_settle",
      "generation_refund",
      "license_hold",
      "license_settle",
      "license_refund",
      "lookup_hold",
      "lookup_settle",
      "lookup_refund",
      "other",
    ]),
    reference_id: identifier,
    unit: z.literal("CREDIT"),
    payment_mode: z.literal("simulated"),
    occurred_at: time,
    entries: z.array(entrySchema).min(2).max(1000),
    rule_version: z.string().max(100).nullable(),
  })
  .strict();
export const jobChargeSchema = z
  .object({
    id: identifier,
    version,
    user_id: identifier,
    status: z.enum(["held", "settled", "refunded"]),
    held: positive,
    charged: integer.refine((v) => integerText(v) && BigInt(v) >= 0n),
    updated_at: time,
  })
  .strict();
export const bundleSchema = z
  .object({
    trades: z.array(tradeSchema).max(10000),
    accounts: z.array(accountSchema).max(50000),
    journals: z.array(journalSchema).max(50000),
    jobs: z.array(jobChargeSchema).max(10000),
  })
  .strict();
export const eventSchema = z
  .object({
    schema_version: z.literal(1),
    event_id: identifier,
    source_cursor: identifier,
    previous_cursor: identifier.nullable(),
    occurred_at: time,
    bundle: bundleSchema,
  })
  .strict();
export const snapshotSchema = z
  .object({
    schema_version: z.literal(1),
    snapshot_id: identifier,
    cursor: identifier.nullable(),
    created_at: time,
    history: z.literal("full"),
    bundle: bundleSchema,
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const batchSchema = z
  .object({ events: z.array(eventSchema).min(1).max(100) })
  .strict();
export const commandSchema = z
  .object({
    command_id: identifier,
    type: z.literal("refund_undelivered"),
    trade_id: identifier,
    expected_version: version,
    amount: positive,
    buyer_id: identifier,
    reason: z.string().trim().min(5).max(1000),
  })
  .strict();
export type Trade = z.infer<typeof tradeSchema>;
export type Account = z.infer<typeof accountSchema>;
export type Journal = z.infer<typeof journalSchema>;
export type Bundle = z.infer<typeof bundleSchema>;
export type SourceEvent = z.infer<typeof eventSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Receipt = {
  command_id: string;
  status: "succeeded" | "rejected";
  code: string;
  trade_id: string;
  version: string;
  journal_id?: string;
};
export const roles = [
  "viewer",
  "operator",
  "approver",
  "auditor",
  "admin",
] as const;
