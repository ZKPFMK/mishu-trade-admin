import { z } from "zod";
import { identifier, integer } from "./index.js";
export const managementType = z.enum([
  "refund_undelivered",
  "retry_settlement",
  "resume_dispute",
  "adjust_credit",
  "hold_trade",
  "release_trade",
]);
export const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const managementInput = z
  .object({
    type: managementType,
    target_id: identifier,
    case_id: identifier,
    amount: integer.optional(),
    reference_command_id: identifier.optional(),
  })
  .strict();
export const managementPreview = z
  .object({
    source_id: identifier,
    operation: managementInput.extend({ amount: integer }),
    fingerprint,
    target_name: z.string(),
    status: z.string(),
    user_id: identifier.nullable(),
    balance: integer,
    hold_case_id: identifier.nullable(),
    accept_by: z.string().nullable(),
  })
  .strict();
export const managementIntent = z
  .object({
    command_id: identifier,
    application_id: identifier,
    source_id: identifier,
    operation: managementInput.extend({ amount: integer }),
    expected_fingerprint: fingerprint,
    reason: z.string().trim().min(5).max(1000),
    evidence: z.string().trim().min(10).max(2000),
    requester_id: identifier,
    requested_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .strict();
export const managementCommand = z
  .object({
    intent: managementIntent,
    authorization: z
      .object({
        approver_id: identifier,
        approved_at: z.iso.datetime(),
        expires_at: z.iso.datetime(),
        request_digest: fingerprint,
        reason: z.string().trim().min(5).max(1000),
      })
      .strict(),
  })
  .strict();
export const managementReceipt = z
  .object({
    command_id: identifier,
    source_id: identifier,
    request_digest: fingerprint,
    type: managementType,
    target_id: identifier,
    status: z.enum(["succeeded", "rejected"]),
    code: z.string().max(100),
    committed_at: z.iso.datetime(),
    journal_ids: z.array(identifier),
  })
  .strict();
export type ManagementInput = z.infer<typeof managementInput>;
export type ManagementPreview = z.infer<typeof managementPreview>;
export type ManagementIntent = z.infer<typeof managementIntent>;
export type ManagementCommand = z.infer<typeof managementCommand>;
export type ManagementReceipt = z.infer<typeof managementReceipt>;
