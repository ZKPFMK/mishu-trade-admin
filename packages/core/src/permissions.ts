import { insist } from "./security.js";

/**
 * Capabilities are deliberately expressed as actions instead of page names.
 * A page can be shared by several roles, while every API and export path must
 * still make the same decision on the server.
 */
export const capabilities = [
  "business:read",
  "operations:read",
  "operations:write",
  "approval:decide",
  "reconciliation:read",
  "reconciliation:run",
  "export:create",
  "export:read",
  "audit:read",
  "system:read",
  "system:manage",
] as const;

export type Capability = (typeof capabilities)[number];

const roleCapabilities: Record<string, readonly Capability[]> = {
  admin: [
    "system:read",
    "system:manage",
    "reconciliation:read",
    "reconciliation:run",
    "audit:read",
  ],
  operator: [
    "business:read",
    "operations:read",
    "operations:write",
    "reconciliation:read",
    "reconciliation:run",
    "export:create",
    "export:read",
  ],
  approver: ["business:read", "operations:read", "approval:decide"],
  viewer: ["business:read"],
  auditor: [
    "business:read",
    "operations:read",
    "reconciliation:read",
    "export:read",
    "audit:read",
  ],
};

export function capabilitiesFor(roles: readonly string[]) {
  return capabilities.filter((capability) =>
    roles.some((role) => roleCapabilities[role]?.includes(capability)),
  );
}

export function hasCapability(
  roles: readonly string[],
  capability: Capability,
) {
  return roles.some((role) => roleCapabilities[role]?.includes(capability));
}

export function requireCapability(
  actor: { roles: readonly string[] },
  capability: Capability,
) {
  insist(hasCapability(actor.roles, capability), 403, "role_forbidden");
}

export type WorkspaceKey =
  | "system"
  | "operations"
  | "approvals"
  | "overview"
  | "audit";

export function defaultWorkspace(roles: readonly string[]): WorkspaceKey {
  if (roles.includes("admin")) return "system";
  if (roles.includes("operator")) return "operations";
  if (roles.includes("approver")) return "approvals";
  if (roles.includes("auditor")) return "audit";
  return "overview";
}

export function workspaceFor(roles: readonly string[]) {
  const workspace = defaultWorkspace(roles);
  return {
    key: workspace,
    capabilities: capabilitiesFor(roles),
    title:
      workspace === "system"
        ? "系统管理"
        : workspace === "operations"
          ? "我的运营"
          : workspace === "approvals"
            ? "审批工作区"
            : workspace === "audit"
              ? "审计工作区"
              : "业务概览",
  };
}
