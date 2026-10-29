import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import {
  actor,
  requireScope,
  requireRole,
} from "../../../packages/core/src/auth.js";
import { identifier } from "../../../packages/contracts/src/index.js";
import {
  caseCreate,
  caseAction,
  caseFilters,
} from "../../../packages/contracts/src/workspace.js";
import {
  workspace,
  listCases,
  assignees,
  createCase,
  actOnCase,
  caseDetail,
  caseSelect,
  readerRoles,
} from "../../../packages/core/src/workspace.js";
import type { Config } from "../../../packages/core/src/config.js";
const appQuery = z.object({ application_id: identifier }).strict();
export function workspaceRoutes(
  api: FastifyInstance,
  db: pg.Pool,
  cfg: Config,
) {
  api.get("/admin/workspace", async (req) => {
    const user = await actor(db, req),
      q = appQuery.parse(req.query);
    return workspace(db, user, q.application_id);
  });
  api.get("/admin/workspace/cases", async (req) =>
    listCases(db, await actor(db, req), caseFilters.parse(req.query)),
  );
  api.get("/admin/case-assignees", async (req) => {
    const user = await actor(db, req),
      q = appQuery.parse(req.query);
    return assignees(db, user, q.application_id);
  });
  api.get("/admin/cases/:id", async (req) =>
    caseDetail(
      db,
      await actor(db, req),
      identifier.parse((req.params as any).id),
      appQuery.partial().parse(req.query).application_id,
    ),
  );
  api.get("/admin/cases", async (req) => {
    const user = await actor(db, req),
      q = appQuery.parse(req.query);
    requireRole(user, ...readerRoles);
    requireScope(user, q.application_id);
    return (
      await db.query(
        caseSelect +
          " WHERE c.application_id=$1 ORDER BY c.updated_at DESC,c.id LIMIT 200",
        [q.application_id],
      )
    ).rows;
  });
  api.post("/admin/cases", async (req) =>
    createCase(db, await actor(db, req), caseCreate.parse(req.body)),
  );
  api.post("/admin/cases/:id", async (req) =>
    actOnCase(
      db,
      cfg,
      await actor(db, req),
      identifier.parse((req.params as any).id),
      caseAction.parse(req.body),
    ),
  );
}
