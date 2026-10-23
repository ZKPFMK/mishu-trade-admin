import { useEffect, useState, useCallback } from "react";
export const errors: Record<string, string> = {
  login_required: "请先登录",
  session_expired: "登录已过期，请重新登录",
  invalid_credentials: "账号或密码不正确",
  role_forbidden: "当前角色没有此操作权限",
  application_forbidden: "无权访问此应用",
  self_approval_forbidden: "申请人与审批人必须不同",
  only_undelivered_funded_orders: "仅可申请退回尚未交付订单的托管积分",
  record_conflict: "记录冲突：可能已有处理中的申请，请查看审批列表",
  csrf_invalid: "会话校验失效，请重新登录",
  real_source_commands_disabled: "真实来源当前只读，尚未开放管理命令",
  source_state_changed: "来源订单已变化，原申请无法继续执行",
  approval_expired: "审批已过期，请重新申请",
  operator_permission_changed: "申请人或审批人权限已变化",
  refund_limit_exceeded: "超过单笔操作限额",
  source_not_initialized: "等待初始数据导入",
  job_already_queued: "已有同类任务排队，请稍后查看进度",
  export_permission_revoked: "导出权限已撤销",
  export_size_limit: "导出超过 2 GiB 上限，请缩小范围",
  excel_cell_limit: "明细超过 Excel 单元格长度限制，请改用压缩 JSONL 导出",
  source_event_conflict: "来源返回了同编号不同内容的事件，请核验",
  invalid_input: "输入格式有误，请检查字段",
  already_initialized: "应用已导入，重复初始化被阻止",
  case_already_claimed: "该工单已由其他人员领取",
  case_owner_only: "仅领取人可以关闭工单",
  source_unavailable: "来源暂时无法访问",
  cursor_gap: "同步游标存在缺口",
  version_gap: "来源对象版本存在缺口",
  unbalanced_transaction: "记账事务不平衡",
  task_failed: "任务失败，请检查服务日志和来源数据",
  approval_invalid: "审批内容校验失败",
  event_not_retryable: "该事件无需重试",
  export_expired: "导出文件已到期，请重新创建任务",
};
export function errorText(code: string) {
  return errors[code] || code;
}
export async function request<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && url !== "/auth/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(errorText(result.error || "请求失败"));
  }
  return result;
}
export function useResource<T = any>(url: string | null, interval = 5000) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    let active = true,
      busy = false;
    const abort = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    const run = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const next = await request<T>(url, { signal: abort.signal });
        if (active) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError")
          setError((e as Error).message);
      } finally {
        busy = false;
        if (active) setLoading(false);
      }
    };
    void run();
    const timer = setInterval(run, interval);
    const visible = () => {
      if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [url, nonce, interval]);
  return { data, error, loading, refresh };
}
export const money = (value: unknown) => {
  try {
    return BigInt(String(value ?? "0")).toLocaleString("zh-CN");
  } catch {
    return "—";
  }
};
export const date = (value: unknown) =>
  value
    ? new Date(String(value)).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      })
    : "—";
export const statusNames: Record<string, string> = {
  FUNDED: "托管中",
  DELIVERED: "待验收",
  DISPUTED: "争议中",
  COMPLETED: "已完成",
  REFUNDED: "已退款",
  RESOLVED_BUYER: "裁决退买家",
  RESOLVED_SELLER: "裁决付卖家",
  pending_approval: "待审批",
  approved: "已审批，待执行",
  executing: "执行中",
  succeeded: "已完成",
  execution_unknown: "结果确认中",
  execution_failed: "执行失败",
  rejected: "已拒绝",
  canceled: "已取消",
  expired: "已到期",
  queued: "排队中",
  running: "处理中",
  failed: "失败",
  open: "待处理",
  closed: "已关闭",
  resolved: "已消除",
  passed: "对账通过",
  differences: "发现差异",
  incomplete: "数据不完整",
  received: "已接收",
  applied: "已应用",
  blocked: "等待补齐",
  quarantined: "已隔离",
  held: "冻结中",
  settled: "已结算",
  refunded: "已退回",
  topup: "模拟充值",
  grant: "赠送",
  fund: "交易托管",
  settle: "交易结算",
  refund: "托管退款",
  generation_hold: "生成冻结",
  generation_settle: "生成结算",
  generation_refund: "生成退回",
  user: "用户可用",
  escrow: "交易托管",
  platform: "平台账户",
  external: "外部对手账户",
};
