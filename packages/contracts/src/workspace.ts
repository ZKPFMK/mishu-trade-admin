import { z } from "zod";
import { identifier } from "./index.js";

export const caseCategories = [
  "follow_up",
  "after_sales",
  "dispute",
  "other",
] as const;
export const casePriorities = ["normal", "high", "urgent"] as const;
export const caseStages = [
  "pending",
  "in_progress",
  "waiting_customer",
  "pending_review",
  "resolved",
] as const;
export const caseCreate = z
  .object({
    application_id: identifier,
    trade_id: identifier.optional(),
    title: z.string().trim().min(5).max(200),
    note: z.string().trim().min(5).max(2000),
    category: z.enum(caseCategories).default("follow_up"),
    priority: z.enum(casePriorities).default("normal"),
    due_at: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export const caseAction = z
  .object({
    action: z.enum([
      "claim",
      "note",
      "close",
      "assign",
      "update",
      "submit_review",
      "review",
    ]),
    note: z.string().trim().min(5).max(2000),
    owner_id: identifier.optional(),
    category: z.enum(caseCategories).optional(),
    priority: z.enum(casePriorities).optional(),
    due_at: z.iso.datetime({ offset: true }).nullable().optional(),
    stage: z.enum(["pending", "in_progress", "waiting_customer"]).optional(),
    decision: z.enum(["accept", "return"]).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const allowed: Record<string, string[]> = {
      claim: [],
      note: [],
      close: [],
      submit_review: [],
      assign: ["owner_id"],
      update: ["category", "priority", "due_at", "stage"],
      review: ["decision"],
    };
    for (const key of Object.keys(value))
      if (!["action", "note", ...allowed[value.action]].includes(key))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Field not allowed for this action",
        });
    if (value.action === "assign" && !value.owner_id)
      ctx.addIssue({
        code: "custom",
        path: ["owner_id"],
        message: "Assignee required",
      });
    if (value.action === "review" && !value.decision)
      ctx.addIssue({
        code: "custom",
        path: ["decision"],
        message: "Review decision required",
      });
  });
export const caseFilters = z
  .object({
    application_id: identifier,
    scope: z
      .enum(["all", "mine", "unassigned", "overdue", "review"])
      .default("all"),
    category: z.enum(caseCategories).optional(),
    priority: z.enum(casePriorities).optional(),
    stage: z.enum(caseStages).optional(),
    q: z.string().trim().max(160).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export type CaseRecord = {
  id: string;
  application_id: string;
  trade_id: string | null;
  title: string;
  state: "open" | "closed";
  owner_id: string | null;
  owner_name: string | null;
  created_by: string;
  category: (typeof caseCategories)[number];
  priority: (typeof casePriorities)[number];
  stage: (typeof caseStages)[number];
  due_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  resolution: string | null;
  review_status: "none" | "pending" | "accepted" | "returned";
  reviewer_id: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  review_submitted_by: string | null;
  requires_review: boolean;
  notes: {
    note: string;
    at: string;
    actor_id: string;
    actor_name: string | null;
    event: Record<string, unknown>;
  }[];
};
export type TradeRisk = {
  id: string;
  status: string;
  asset_title: string;
  price: string;
  buyer_id: string;
  seller_id: string;
  updated_at: string;
  created_at: string;
  open_cases: number;
};
export type TeamMember = {
  id: string;
  name: string;
  open: number;
  overdue: number;
  review: number;
  closed_7d: number;
};
export type Workspace = {
  summary: {
    open: number;
    mine: number;
    unassigned: number;
    overdue: number;
    review: number;
    pending_approvals: number;
    disputed_trades: number;
    awaiting_delivery: number;
    awaiting_acceptance: number;
  };
  cases: CaseRecord[];
  risks: TradeRisk[];
  team: TeamMember[];
  capabilities: {
    manage_cases: boolean;
    review_cases: boolean;
    assign_cases: boolean;
    view_team: boolean;
  };
  sync: {
    initialized: boolean;
    last_poll_at: string | null;
    last_applied_at: string | null;
    source_error: string | null;
  };
  generated_at: string;
};
