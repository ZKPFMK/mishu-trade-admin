import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ROOT } from "../packages/core/src/config.js";
import {
  eventSchema,
  snapshotSchema,
  batchSchema,
  tradeSchema,
  journalSchema,
  accountSchema,
  commandSchema,
  identifier,
  roles,
} from "../packages/contracts/src/index.js";
import { exportSchema } from "../packages/core/src/exports.js";
const reason = z.string().trim().min(5).max(1000);
const raw = {
  Event: eventSchema,
  Snapshot: snapshotSchema,
  EventBatch: batchSchema,
  Trade: tradeSchema,
  Journal: journalSchema,
  Account: accountSchema,
  SourceCommand: commandSchema,
  ExportRequest: exportSchema.extend({ application_id: identifier }),
  Login: z
    .object({ email: z.email().max(254), password: z.string().min(1).max(200) })
    .strict(),
  PasswordChange: z
    .object({
      current: z.string().max(200),
      password: z.string().min(12).max(200),
    })
    .strict(),
  OperationRequest: z
    .object({
      application_id: identifier,
      trade_id: identifier,
      reason,
      idempotency_key: identifier,
    })
    .strict(),
  Decision: z.object({ reason }).strict(),
  ApplicationJob: z.object({ application_id: identifier }).strict(),
  CaseCreate: z
    .object({
      application_id: identifier,
      trade_id: identifier.optional(),
      title: z.string().trim().min(5).max(200),
      note: z.string().trim().min(5).max(2000),
    })
    .strict(),
  CaseUpdate: z
    .object({
      action: z.enum(["claim", "note", "close"]),
      note: z.string().trim().min(5).max(2000),
    })
    .strict(),
  OperatorCreate: z
    .object({
      email: z.email().max(254),
      name: z.string().trim().min(1).max(100),
      roles: z.array(z.enum(roles)).min(1),
      scopes: z.array(identifier).min(1),
    })
    .strict(),
  OperatorAccess: z.object({ enabled: z.boolean() }).strict(),
  CredentialCreate: z
    .object({
      application_id: identifier,
      label: z.string().trim().min(1).max(100),
      permissions: z
        .array(z.enum(["events:write", "sync:read", "imports:write"]))
        .min(1),
    })
    .strict(),
};
const schemas = Object.fromEntries(
  Object.entries(raw).map(([name, schema]) => {
    const { $schema, ...definition } = z.toJSONSchema(schema);
    return [name, definition];
  }),
);
const paths: Record<string, any> = {};
function add(
  method: string,
  url: string,
  summary: string,
  service = false,
  body?: string,
) {
  const parameters = [...url.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  if (
    !service &&
    url.startsWith("/admin/") &&
    method === "get" &&
    !["/admin/applications", "/admin/operators"].includes(url) &&
    !url.includes("/files/")
  )
    parameters.push({
      name: "application_id",
      in: "query",
      required: true,
      schema: { type: "string" },
    });
  paths[url] ??= {};
  paths[url][method] = {
    summary,
    security: [
      service
        ? { serviceToken: [] }
        : {
            sessionCookie: [],
            ...(method === "post" ? { csrfToken: [] } : {}),
          },
    ],
    parameters,
    responses: {
      "200": {
        description:
          method === "post"
            ? "Request accepted; asynchronous state is returned separately."
            : "Scoped result.",
      },
      "400": { description: "Invalid input" },
      "401": { description: "Authentication required" },
      "403": {
        description: "Role, scope, credential purpose or CSRF rejected",
      },
      "409": { description: "State/version/idempotency conflict" },
    },
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/" + body },
              },
            },
          },
        }
      : {}),
  };
}
add(
  "post",
  "/v1/events/batches",
  "Persist up to 100 events; per-event duplicate/conflict result. Acceptance is not application.",
  true,
  "EventBatch",
);
add(
  "get",
  "/v1/events/{event_id}",
  "Query event state for the credential application.",
  true,
);
add(
  "post",
  "/v1/imports",
  "Queue a first consistent snapshot import (maximum 50 MiB).",
  true,
  "Snapshot",
);
add(
  "get",
  "/v1/imports/{id}",
  "Query import validation and activation state.",
  true,
);
add(
  "get",
  "/v1/sync/status",
  "Read received/applied checkpoint and event backlog.",
  true,
);
for (const name of [
  "overview",
  "trades",
  "accounts",
  "journal-transactions",
  "settlements",
  "generation-jobs",
  "operation-requests",
  "cases",
  "reconciliation-runs",
  "reconciliation-findings",
  "exports",
  "applications",
  "operators",
  "audit-events",
  "events",
  "event-conflicts",
  "imports",
  "credentials",
])
  add("get", "/admin/" + name, "Read " + name);
add(
  "get",
  "/admin/trades/{id}",
  "Order detail with complete journal, escrow and operations",
);
for (const name of [
  "operation-requests",
  "cases",
  "reconciliation-runs",
  "imports",
  "operators",
  "credentials",
])
  add("post", "/admin/" + name, "Create " + name);
add(
  "post",
  "/admin/exports",
  "Queue a scoped export; request also requires application_id",
);
for (const action of ["approve", "reject", "cancel"])
  add(
    "post",
    `/admin/operation-requests/{id}/${action}`,
    action + " immutable operation (reason required)",
  );
for (const action of ["cancel", "retry"])
  add("post", `/admin/exports/{id}/${action}`, action + " own export");
add(
  "get",
  "/admin/exports/{id}/files/{name}",
  "Native authenticated attachment; revalidates owner, scope and expiry",
);
add("post", "/admin/cases/{id}", "Claim, append note, or close owned case");
add(
  "post",
  "/admin/reconciliation-findings/{id}/claim",
  "Claim an unresolved finding",
);
add(
  "post",
  "/admin/events/{id}/retry",
  "Replay quarantined/blocked event (application_id query required)",
);
add(
  "post",
  "/admin/event-conflicts/{id}/resolve",
  "Record reasoned conflict review without overwriting the original event",
);
add(
  "post",
  "/admin/operators/{id}/access",
  "Enable/disable scoped operator and revoke active sessions",
);
add("post", "/admin/credentials/{id}/revoke", "Revoke service credential");
add(
  "post",
  "/auth/login",
  "Login and set an HttpOnly same-site session cookie",
  false,
  "Login",
);
paths["/auth/login"].post.security = [];
add("get", "/auth/me", "Current operator and CSRF token");
add("post", "/auth/logout", "Revoke current session");
add(
  "post",
  "/auth/password",
  "Change password and revoke all operator sessions",
  false,
  "PasswordChange",
);
const bodies: Record<string, string> = {
  "/admin/operation-requests": "OperationRequest",
  "/admin/cases": "CaseCreate",
  "/admin/cases/{id}": "CaseUpdate",
  "/admin/reconciliation-runs": "ApplicationJob",
  "/admin/imports": "ApplicationJob",
  "/admin/exports": "ExportRequest",
  "/admin/operators": "OperatorCreate",
  "/admin/operators/{id}/access": "OperatorAccess",
  "/admin/credentials": "CredentialCreate",
  "/admin/event-conflicts/{id}/resolve": "Decision",
};
for (const action of ["approve", "reject", "cancel"])
  bodies[`/admin/operation-requests/{id}/${action}`] = "Decision";
for (const [url, schema] of Object.entries(bodies))
  paths[url].post.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/" + schema },
      },
    },
  };
paths["/admin/events/{id}/retry"].post.parameters.push({
  name: "application_id",
  in: "query",
  required: true,
  schema: { type: "string" },
});
for (const dataset of [
  "trades",
  "accounts",
  "journal-transactions",
  "settlements",
  "generation-jobs",
]) {
  for (const field of ["q", "status", "from", "to", "cursor"])
    paths["/admin/" + dataset].get.parameters.push({
      name: field,
      in: "query",
      schema: { type: "string" },
    });
  for (const [field, max] of [
    ["page", 1000],
    ["limit", 100],
  ] as const)
    paths["/admin/" + dataset].get.parameters.push({
      name: field,
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: max },
    });
}
const spec = {
  openapi: "3.1.0",
  info: {
    title: "MiShu Trade Admin",
    version: "0.1.0",
    description:
      "Runtime-validated ingress schemas. Administrative body details and source responsibilities are documented in docs/source-contract.md. SourceCommand is the source-side mock contract; real source execution is disabled.",
  },
  servers: [{ url: "http://localhost:8920" }],
  paths,
  components: {
    securitySchemes: {
      serviceToken: { type: "http", scheme: "bearer" },
      sessionCookie: { type: "apiKey", in: "cookie", name: "trade_session" },
      csrfToken: { type: "apiKey", in: "header", name: "X-CSRF-Token" },
    },
    schemas,
  },
};
fs.writeFileSync(
  path.join(ROOT, "packages/contracts/openapi.json"),
  JSON.stringify(spec, null, 2) + "\n",
);
console.log("Generated packages/contracts/openapi.json from runtime schemas");
