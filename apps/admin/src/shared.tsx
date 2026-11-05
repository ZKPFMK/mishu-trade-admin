import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./appearance";
import { statusNames } from "./api";
export type User = {
  id: string;
  email: string;
  name: string;
  roles: string[];
  scopes: string[];
  csrf: string;
  workspace?: {
    key: string;
    title: string;
    capabilities: string[];
  };
};
export type Context = {
  user: User;
  app: any;
  url: (path: string, extra?: Record<string, string>) => string;
  mutate: (path: string, body?: unknown) => Promise<any>;
  notify: (text: string) => void;
};
export const roleLabels: Record<string, string> = {
  admin: "系统管理员",
  operator: "运营处理",
  approver: "独立审批",
  viewer: "运营查看",
  auditor: "审计",
};
export function AccessSummary({
  user,
  app,
  applicationCount,
}: {
  user: User;
  app: { name: string } | undefined;
  applicationCount: number;
}) {
  return (
    <section className="access-summary" aria-label="当前登录身份">
      <div>
        <span className="caption">当前登录</span>
        <strong>{user.name}</strong>
        <span className="mono">{user.email}</span>
      </div>
      <div aria-label="我的岗位">
        {user.roles.map((role) => (
          <span className="badge" key={role}>
            {roleLabels[role] || role}
          </span>
        ))}
      </div>
      <p className="caption">
        默认工作区：{user.workspace?.title || "业务概览"} · 当前授权应用：
        {app?.name || "尚未分配"} · 共 {applicationCount} 个授权应用
      </p>
    </section>
  );
}
export function Badge({ value }: { value: string }) {
  return (
    <span
      className={
        "badge " +
        ([
          "COMPLETED",
          "RESOLVED_SELLER",
          "succeeded",
          "passed",
          "applied",
          "resolved",
          "settled",
        ].includes(value)
          ? "ok"
          : [
                "failed",
                "execution_failed",
                "DISPUTED",
                "differences",
                "quarantined",
              ].includes(value)
            ? "danger"
            : [
                  "pending_approval",
                  "approved",
                  "FUNDED",
                  "DELIVERED",
                  "running",
                  "blocked",
                  "execution_unknown",
                  "incomplete",
                ].includes(value)
              ? "warn"
              : "")
      }
    >
      {statusNames[value] || value}
    </span>
  );
}
export function Alert({ children }: { children: ReactNode }) {
  return children ? (
    <div className="alert" role="alert">
      {children}
    </div>
  ) : null;
}
export function Empty({ children = "暂无记录" }: { children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name="submissions" />
      <p>{children}</p>
    </div>
  );
}
export function Panel({
  title,
  children,
  action,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-heading">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="panel-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function ActionForm({
  title,
  description,
  label = "确认",
  onClose,
  onSubmit,
}: {
  title: string;
  description: ReactNode;
  label?: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{description}</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(reason);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          处理理由
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={5}
            maxLength={1000}
            rows={4}
            placeholder="请填写至少 5 个字，作为操作与审批依据"
          />
        </label>
        <Alert>{error}</Alert>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在提交…" : label}
          </button>
        </div>
      </form>
    </Modal>
  );
}
