import { useEffect, useState, type ReactNode } from "react";
import { useResource, money, date, statusNames, errorText } from "./api";
export const managementNames: Record<string, string> = {
  refund_undelivered: "未交付托管退款",
  retry_settlement: "重试到期结算",
  resume_dispute: "恢复已核验的争议裁决",
  adjust_credit: "积分补偿 / 冲正",
  hold_trade: "暂停订单处理",
  release_trade: "解除订单暂停",
};
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭弹窗"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function ManagementDialog({
  c,
  initial,
  onClose,
  onDone,
}: {
  c: any;
  initial?: { type: string; target: string };
  onClose: () => void;
  onDone?: () => void;
}) {
  const [type, setType] = useState(initial?.type || "refund_undelivered"),
    [target, setTarget] = useState(initial?.target || ""),
    [caseId, setCase] = useState(""),
    [amount, setAmount] = useState(""),
    [reference, setReference] = useState(""),
    [reason, setReason] = useState(""),
    [evidence, setEvidence] = useState(""),
    [password, setPassword] = useState(""),
    [otp, setOtp] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const cases = useResource<any[]>(c.url("/admin/cases"));
  const reset = () => {
    setPreview(null);
    setKey(crypto.randomUUID());
  };
  const input = () => ({
    type,
    target_id: target.trim(),
    case_id: caseId,
    ...(type === "adjust_credit"
      ? {
          amount,
          ...(reference.trim()
            ? { reference_command_id: reference.trim() }
            : {}),
        }
      : {}),
  });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="发起运营处理" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (!preview) {
              setPreview(
                await c.mutate("/admin/management/preview", {
                  application_id: c.app.id,
                  input: input(),
                }),
              );
              return;
            }
            await c.mutate("/admin/management/requests", {
              application_id: c.app.id,
              input: preview.operation,
              expected_fingerprint: preview.fingerprint,
              reason,
              evidence,
              idempotency_key: key,
              password,
              otp,
            });
            setPassword("");
            setOtp("");
            c.notify("申请已提交，等待另一位审批人确认");
            onDone?.();
            onClose();
          });
        }}
      >
        <label>
          处理类型
          <select
            value={type}
            disabled={!!preview}
            onChange={(e) => {
              setType(e.target.value);
              reset();
            }}
          >
            {Object.entries(managementNames).map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {type === "adjust_credit"
            ? "用户积分账户（user:用户编号）"
            : "订单编号"}
          <input
            value={target}
            required
            disabled={!!preview}
            onChange={(e) => {
              setTarget(e.target.value);
              reset();
            }}
          />
        </label>
        {type === "adjust_credit" && (
          <>
            <label>
              积分变化（补偿为正数；冲正为原补偿的负数）
              <input
                inputMode="numeric"
                pattern="-?[1-9][0-9]*"
                required
                value={amount}
                disabled={!!preview}
                onChange={(e) => {
                  setAmount(e.target.value);
                  reset();
                }}
              />
            </label>
            <label>
              原补偿命令编号（冲正时必填）
              <input
                value={reference}
                disabled={!!preview}
                onChange={(e) => {
                  setReference(e.target.value);
                  reset();
                }}
              />
            </label>
            <p className="caption">
              只操作用户可用积分。冲正必须关联原补偿，按原金额完整撤回；余额不足时拒绝。每个工单对同一账户仅补偿一次。
            </p>
          </>
        )}
        <label>
          处理依据与凭证编号
          <textarea
            required
            minLength={10}
            maxLength={2000}
            value={evidence}
            onChange={(e) => {
              setEvidence(e.target.value);
              setKey(crypto.randomUUID());
            }}
            placeholder="说明核验结果，填写相关订单、流水、用户反馈或证据文件编号"
          />
        </label>
        <label>
          关联工单
          <select
            required
            value={caseId}
            disabled={!!preview}
            onChange={(e) => {
              setCase(e.target.value);
              reset();
            }}
          >
            <option value="">选择本人已领取的开放工单</option>
            {cases.data
              ?.filter(
                (x) =>
                  x.state === "open" &&
                  x.owner_id === c.user.id &&
                  (type === "adjust_credit" || x.trade_id === target),
              )
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title} · {x.id}
                </option>
              ))}
          </select>
        </label>
        {!preview && (
          <button
            type="button"
            disabled={busy || !target || evidence.trim().length < 10}
            onClick={() =>
              void run(async () => {
                const created = await c.mutate("/admin/management/cases", {
                  application_id: c.app.id,
                  ...(type === "adjust_credit"
                    ? {}
                    : { trade_id: target.trim() }),
                  title: (managementNames[type] + "：" + target).slice(0, 200),
                  evidence,
                });
                setCase(created.id);
                cases.refresh();
              })
            }
          >
            新建并领取处理工单
          </button>
        )}
        <label>
          申请理由
          <textarea
            required
            minLength={5}
            maxLength={1000}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setKey(crypto.randomUUID());
            }}
          />
        </label>
        {preview && (
          <>
            <div className="facts">
              <span>
                处理对象<strong>{preview.target_name}</strong>
              </span>
              <span>
                当前状态
                <strong>{statusNames[preview.status] || preview.status}</strong>
              </span>
              <span>
                {type === "adjust_credit" ? "积分变化" : "涉及积分"}
                <strong>{money(preview.operation.amount)} CREDIT</strong>
              </span>
              <span>
                {type === "adjust_credit" ? "当前可用余额" : "当前托管余额"}
                <strong>{money(preview.balance)} CREDIT</strong>
              </span>
              {type === "adjust_credit" && (
                <span>
                  预计处理后余额
                  <strong>
                    {money(
                      BigInt(preview.balance) +
                        BigInt(preview.operation.amount),
                    )}{" "}
                    CREDIT
                  </strong>
                </span>
              )}
            </div>
            <p className="caption">
              请核对对象、金额与工单。审批有效期 15
              分钟；执行时会重新校验权限和来源状态。提交申请不会立即暂停订单。
            </p>
            <label>
              当前账号密码
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label>
              动态验证码或恢复码
              <input
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="已绑定验证器时必填；正式环境必须绑定"
              />
            </label>
          </>
        )}
        {error && (
          <div role="alert" className="alert">
            {error}
          </div>
        )}
        <div className="form-actions">
          {preview && (
            <button type="button" onClick={reset}>
              重新核对
            </button>
          )}
          <button className="primary" disabled={busy}>
            {busy ? "处理中…" : preview ? "提交独立审批" : "核对来源状态"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
export function ManagementPanel({ c }: { c: any }) {
  const [page, setPage] = useState(1),
    [jump, setJump] = useState("1"),
    [state, setState] = useState(""),
    [create, setCreate] = useState(false),
    [decision, setDecision] = useState<any>(null),
    [reason, setReason] = useState(""),
    [password, setPassword] = useState(""),
    [otp, setOtp] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const r = useResource<any>(
    c.url("/admin/management/requests", { page, ...(state ? { state } : {}) }),
  );
  const open = (o: any, action: string) => {
    setDecision({ o, action });
    setReason("");
    setPassword("");
    setOtp("");
    setError("");
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>运营处理与独立审批</h2>
        {c.app.management_available && c.user.roles.includes("operator") && (
          <button className="primary" onClick={() => setCreate(true)}>
            发起运营处理
          </button>
        )}
      </div>
      <p className="caption">
        退款、结算重试、暂停、解除和积分补偿均由主平台校验执行。结果待确认时持续查询原命令，不另建退款命令。
      </p>
      {!c.app.management_available && (
        <div className="alert">
          当前应用尚未启用运营命令，请完成两端独立凭证与权限配置。
        </div>
      )}
      <select
        aria-label="运营处理状态"
        value={state}
        onChange={(e) => {
          setState(e.target.value);
          setPage(1);
          setJump("1");
        }}
      >
        <option value="">全部处理状态</option>
        {[
          "pending_approval",
          "approved",
          "executing",
          "execution_unknown",
          "succeeded",
          "execution_failed",
          "rejected",
          "canceled",
          "expired",
        ].map((s) => (
          <option value={s} key={s}>
            {statusNames[s]}
          </option>
        ))}
      </select>
      {r.error && (
        <div role="alert" className="alert">
          {r.error}
        </div>
      )}
      {!r.loading && !r.data?.items.length && (
        <p className="empty">暂无运营处理申请</p>
      )}
      {r.data?.items.map((o: any) => (
        <article className="operation" key={o.id}>
          <div className="record-row">
            <strong>{managementNames[o.type]}</strong>
            <span
              className={
                "badge " +
                (o.state === "succeeded"
                  ? "ok"
                  : o.state === "execution_unknown"
                    ? "warn"
                    : "")
              }
            >
              {statusNames[o.state] || o.state}
            </span>
            <strong>{money(o.intent.operation.amount)} CREDIT</strong>
          </div>
          <p className="mono">{o.target_id}</p>
          <p>{o.intent.reason}</p>
          <details>
            <summary>核验依据与审批记录</summary>
            <p>{o.intent.evidence}</p>
            <p>工单 {o.case_id}</p>
            <p>审批意见：{o.decision_reason || "待审批"}</p>
            <code>{o.id}</code>
          </details>
          <p className="caption">
            申请人 {o.requester_name} · 审批人 {o.approver_name || "待指定"} ·{" "}
            {date(o.created_at)}
          </p>
          {o.receipt && (
            <p className="caption">
              来源回执：{o.receipt.command_id} · {errorText(o.receipt.code)}
              {o.projection_synced === false
                ? " · 流水同步中"
                : o.projection_synced === true
                  ? " · 流水已同步"
                  : ""}
            </p>
          )}
          {o.error && (
            <p className="alert">
              {o.error === "source_result_unknown"
                ? "来源结果尚待确认，系统将继续查询原命令；请勿重复创建处理申请。"
                : errorText(o.error)}
            </p>
          )}
          <div className="form-actions">
            {o.state === "pending_approval" &&
              c.user.roles.includes("approver") &&
              o.requester_id !== c.user.id && (
                <>
                  <button
                    className="primary"
                    onClick={() => open(o, "approve")}
                  >
                    独立审批
                  </button>
                  <button onClick={() => open(o, "reject")}>拒绝申请</button>
                </>
              )}
            {["pending_approval", "approved"].includes(o.state) &&
              o.requester_id === c.user.id &&
              !o.dispatched_at && (
                <button onClick={() => open(o, "cancel")}>撤销申请</button>
              )}
          </div>
        </article>
      ))}
      <div className="pagination">
        <span>
          第 {page} 页 · 共{" "}
          {Math.max(1, Math.ceil(Number(r.data?.total || 0) / 25))} 页
        </span>
        <button
          disabled={page <= 1}
          onClick={() => {
            setPage(page - 1);
            setJump(String(page - 1));
          }}
        >
          上一页
        </button>
        <button
          disabled={page * 25 >= Number(r.data?.total || 0)}
          onClick={() => {
            setPage(page + 1);
            setJump(String(page + 1));
          }}
        >
          下一页
        </button>
        <input
          aria-label="运营处理跳转页码"
          type="number"
          min="1"
          max="1000"
          value={jump}
          onChange={(e) => setJump(e.target.value)}
        />
        <button
          onClick={() =>
            setPage(
              Math.max(
                1,
                Math.min(
                  1000,
                  Math.ceil(Number(r.data?.total || 0) / 25) || 1,
                  Number(jump) || 1,
                ),
              ),
            )
          }
        >
          跳转
        </button>
      </div>
      {create && (
        <ManagementDialog
          c={c}
          onClose={() => setCreate(false)}
          onDone={r.refresh}
        />
      )}
      {decision && (
        <Dialog
          title={decision.action === "approve" ? "独立审批确认" : "处理申请"}
          onClose={() => setDecision(null)}
        >
          <p>
            {managementNames[decision.o.type]} · {decision.o.target_id} ·{" "}
            {money(decision.o.intent.operation.amount)} CREDIT
          </p>
          <p>{decision.o.intent.reason}</p>
          <p className="caption">{decision.o.intent.evidence}</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await c.mutate(
                  "/admin/management/requests/" +
                    decision.o.id +
                    "/" +
                    decision.action,
                  {
                    reason,
                    ...(decision.action === "approve" ? { password, otp } : {}),
                  },
                );
                setDecision(null);
                setPassword("");
                setOtp("");
                r.refresh();
                c.notify("处理意见已记录");
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              处理意见
              <textarea
                required
                minLength={5}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            {decision.action === "approve" && (
              <>
                <label>
                  当前账号密码
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label>
                  动态验证码或恢复码
                  <input
                    autoComplete="one-time-code"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                  />
                </label>
              </>
            )}
            {error && (
              <div role="alert" className="alert">
                {error}
              </div>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "提交中…" : "确认处理"}
            </button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
export function SecurityDialog({
  c,
  onClose,
}: {
  c: any;
  onClose: () => void;
}) {
  const r = useResource<any>("/auth/security"),
    [password, setPassword] = useState(""),
    [otp, setOtp] = useState(""),
    [setup, setSetup] = useState<any>(null),
    [codes, setCodes] = useState<string[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="账号安全验证" onClose={onClose}>
      <p>
        运营申请和审批需要重新验证身份。正式环境还要求动态验证码；可使用支持
        TOTP 的身份验证器。
      </p>
      {codes ? (
        <>
          <p>恢复码仅显示一次。每个只能使用一次，请保存到密码管理器。</p>
          <pre className="secret">{codes.join("\n")}</pre>
          <button
            onClick={() => {
              const a = document.createElement("a");
              a.href = URL.createObjectURL(
                new Blob([codes.join("\n")], { type: "text/plain" }),
              );
              a.download = "mishu-trade-recovery-codes.txt";
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }}
          >
            下载恢复码
          </button>
          <button className="primary" onClick={onClose}>
            我已安全保存
          </button>
        </>
      ) : (
        <>
          <p className="badge">
            {r.data?.enabled ? "已绑定验证器" : "尚未绑定验证器"}
          </p>
          <label>
            当前账号密码
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {setup && (
            <>
              <p>
                在验证器中选择“手动输入密钥”，名称填 MiShu
                Trade，类型选“基于时间”。
              </p>
              <code className="secret">{setup.secret}</code>
              <p className="caption">
                绑定密钥仅用于你自己的验证器，请勿分享。
              </p>
            </>
          )}
          {(setup || r.data?.enabled) && (
            <label>
              动态验证码或恢复码
              <input
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
              />
            </label>
          )}
          {!r.data?.enabled && !setup && (
            <button
              className="primary"
              disabled={busy || !password}
              onClick={() =>
                void run(async () =>
                  setSetup(await c.mutate("/auth/mfa/setup", { password })),
                )
              }
            >
              开始绑定验证器
            </button>
          )}
          {setup && (
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await c.mutate("/auth/mfa/confirm", { otp });
                  setCodes(result.recovery_codes);
                  setSetup(null);
                  setPassword("");
                  setOtp("");
                  r.refresh();
                })
              }
            >
              验证并完成绑定
            </button>
          )}
          {r.data?.enabled && (
            <>
              <p className="caption">
                剩余恢复码：{r.data.recovery_codes_remaining}
                。同一个动态验证码不能重复使用；登录后执行操作时可能需等待下一组验证码。
              </p>
              <button
                disabled={busy || !password || !otp}
                onClick={() =>
                  void run(async () => {
                    await c.mutate("/auth/mfa/disable", { password, otp });
                    window.dispatchEvent(new Event("session-expired"));
                    onClose();
                  })
                }
              >
                验证并解除绑定
              </button>
            </>
          )}
        </>
      )}
      {(error || r.error) && (
        <div role="alert" className="alert">
          {error || r.error}
        </div>
      )}
    </Dialog>
  );
}
