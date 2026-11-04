import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "../packages/core/src/config.js";
import { identifier } from "../packages/contracts/src/index.js";

export const previewRoles = [
  ["admin", "系统管理员"],
  ["operator", "运营处理"],
  ["approver", "独立审批"],
  ["viewer", "运营查看"],
  ["auditor", "审计"],
] as const;
type PreviewAccount = {
  id: string;
  email: string;
  password: string;
  name: string;
  roles: string[];
};
export type PreviewCredentials = {
  console: string;
  application_id: string;
  mode: "mock";
  operators: PreviewAccount[];
};

/** Create dedicated local preview identities through the existing audited admin API. */
export async function setupRolePreviews(input: {
  baseUrl: string;
  applicationId: string;
  admin: { email: string; password: string };
  outputFile: string;
}) {
  const url = new URL(input.baseUrl),
    app = identifier.parse(input.applicationId);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Role previews require a local console origin");
  const base = url.origin;
  async function login(credentials: { email: string; password: string }) {
    const r = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("Preview login failed: HTTP " + r.status);
    const cookie = r.headers.getSetCookie()[0]?.split(";")[0],
      csrf = (await r.json()).csrf;
    if (!cookie || !csrf)
      throw new Error("Preview login did not return a session");
    return { cookie, csrf };
  }
  async function api(
    session: { cookie: string; csrf: string },
    route: string,
    body?: unknown,
  ) {
    const r = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: session.cookie,
        "X-CSRF-Token": session.csrf,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(route + ": HTTP " + r.status);
    return r.json();
  }
  const session = await login(input.admin);
  try {
    const applications = await api(session, "/admin/applications"),
      application = applications.find((a: any) => a.id === app);
    if (
      !application ||
      application.source_mode !== "mock" ||
      application.environment !== "test"
    )
      throw new Error(
        "Role previews require an authorized mock test application",
      );
    const people = await api(session, "/admin/operators");
    let stored: PreviewCredentials = {
      console: base,
      application_id: app,
      mode: "mock",
      operators: [],
    };
    if (fs.existsSync(input.outputFile)) {
      stored = JSON.parse(fs.readFileSync(input.outputFile, "utf8"));
      if (
        stored.console !== base ||
        stored.application_id !== app ||
        stored.mode !== "mock"
      )
        throw new Error(
          "Existing preview credentials belong to another console or application",
        );
    }
    // Preflight all collisions before creating anything. Never overwrite another account or its password.
    for (const [role] of previewRoles) {
      const email = `preview-${role}@trade-admin.local`,
        existing = people.find((p: any) => p.email === email),
        saved = stored.operators.find((p) => p.email === email);
      if (
        existing &&
        (!saved ||
          existing.id !== saved.id ||
          !existing.enabled ||
          existing.roles.length !== 1 ||
          existing.roles[0] !== role ||
          existing.scopes.length !== 1 ||
          existing.scopes[0] !== app)
      )
        throw new Error(
          "Existing preview identity does not match the saved single-role account: " +
            email,
        );
      if (saved && !existing)
        throw new Error("Saved preview account is missing: " + email);
    }
    fs.mkdirSync(path.dirname(input.outputFile), {
      recursive: true,
      mode: 0o700,
    });
    const save = () => {
      fs.writeFileSync(
        input.outputFile,
        JSON.stringify(stored, null, 2) + "\n",
        { mode: 0o600 },
      );
      fs.chmodSync(input.outputFile, 0o600);
    };
    for (const [role, label] of previewRoles) {
      const email = `preview-${role}@trade-admin.local`;
      let account = stored.operators.find((p) => p.email === email);
      if (!account) {
        const name = "岗位体验 · " + label,
          created = await api(session, "/admin/operators", {
            email,
            name,
            roles: [role],
            scopes: [app],
          });
        account = {
          id: created.id,
          email,
          password: created.password,
          name,
          roles: [role],
        };
        stored.operators.push(account);
        save();
      }
      const proof = await login(account);
      try {
        const me = await api(proof, "/auth/me");
        if (
          me.id !== account.id ||
          me.roles.length !== 1 ||
          me.roles[0] !== role ||
          me.scopes.length !== 1 ||
          me.scopes[0] !== app
        )
          throw new Error("Preview account permissions changed: " + email);
      } finally {
        await api(proof, "/auth/logout", {});
      }
    }
    return stored;
  } finally {
    await api(session, "/auth/logout", {});
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const original = JSON.parse(
    fs.readFileSync(path.join(ROOT, ".local/credentials.json"), "utf8"),
  );
  const admin = original.operators.find((p: any) => p.roles.includes("admin"));
  if (!admin) throw new Error("Local administrator credentials not found");
  const outputFile = path.join(ROOT, ".local/role-preview-accounts.json");
  const result = await setupRolePreviews({
    baseUrl: original.console,
    applicationId: original.application_id,
    admin,
    outputFile,
  });
  console.log(
    `${result.operators.length} single-role preview accounts verified. Credentials: .local/role-preview-accounts.json`,
  );
}
