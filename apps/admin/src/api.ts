import { useEffect, useState, useCallback } from "react";
export const errors: Record<string, string> = {
  rate_limited: "操作过于频繁，请稍后重试",
  ok: "执行成功",
  management_disabled: "当前应用尚未启用运营处理",
  management_amount_limit_exceeded: "超过当前应用单笔处理限额",
  adjustment_limit_exceeded: "超过单笔积分补偿或冲正限额",
  adjustment_daily_limit_exceeded: "已达今日积分调账限额，请交由负责人核验",
  invalid_adjustment_reference: "原补偿命令不存在或不属于此账户",
  reversal_amount_mismatch: "冲正金额必须等于原补偿金额的负数",
  adjustment_already_reversed: "这笔补偿已经冲正，请勿重复处理",
  debit_requires_original_adjustment:
    "扣减仅用于撤回原补偿，请填写原补偿命令编号",
  case_already_compensated: "本工单已补偿过此账户，请查看原处理结果",
  insufficient_available_credits: "用户可用积分不足，不能执行本次冲正",
  user_account_required: "请填写用户账户编号，格式为 user:用户编号",
  user_account_not_found: "用户积分账户不存在",
  open_case_required: "请关联本人已领取且仍开放的工单",
  case_target_mismatch: "工单与当前处理订单不一致",
  case_has_active_operations: "工单仍有待处理申请或结果待确认，请先完成处理",
  case_has_active_hold: "订单仍在暂停中，请先解除暂停或完成处理",
  order_cannot_be_held: "当前订单状态不允许暂停",
  order_not_held: "订单当前没有暂停",
  held_by_another_case: "订单已被其他工单暂停，请联系该工单负责人",
  settlement_not_due: "订单尚未到原定结算时间，不能提前结算",
  verified_dispute_required: "需要主平台已有的有效争议裁决才能恢复执行",
  asset_owner_changed: "作品归属或可交易状态已变化，请先核查",
  escrow_mismatch: "托管余额与订单金额不一致，请先对账",
  command_canceled: "原命令已作废，主平台不会继续执行",
  request_expired: "申请已过期，请核验当前状态后重新申请",
  execution_already_started: "执行已开始，请等待原命令结果",
  not_pending_approval: "申请状态已变化，请查看最新结果",
  mfa_not_configured: "服务尚未配置验证器加密密钥，请联系管理员",
  mfa_enrollment_required: "正式应用操作前须先在“安全验证”绑定验证器",
  mfa_invalid: "验证码或恢复码无效",
  mfa_code_reused: "该验证码已使用，请等待下一组验证码",
  mfa_setup_expired: "绑定已过期，请重新开始绑定",
  mfa_already_enabled: "账号已绑定验证器",
  reauth_invalid: "当前账号密码不正确",
  reauth_locked: "连续验证失败过多，请 15 分钟后重试",
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
  case_owner_only: "仅工单负责人可以执行此处理，请先领取或联系负责人",
  case_not_found: "工单不存在或已不可用，请刷新列表",
  case_application_mismatch: "工单不属于当前应用，请切换到正确的应用后查看",
  trade_not_found: "当前应用中没有这笔订单，请检查订单编号",
  case_closed: "工单已结案，不能继续修改",
  case_review_pending: "工单正在核验中，请等待核验结果后继续处理",
  case_assignee_invalid: "该人员未启用或没有当前应用的工单处理权限",
  case_not_pending_review: "工单已不在待核验阶段，请刷新查看最新状态",
  self_review_forbidden:
    "工单负责人或提交人不能核验自己的工单，请交由另一位审核人员",
  case_review_required: "此工单需要独立核验通过后才能结案",
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
  CREATED: "已创建",
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
  license_escrow: "许可报价托管",
  license_hold: "许可报价冻结",
  license_settle: "许可报价结算",
  license_refund: "许可报价退回",
  lookup_hold: "私密检索冻结",
  lookup_settle: "私密检索结算",
  lookup_refund: "私密检索退回",
  adjustment: "运营补偿 / 冲正",
  AVAILABLE: "可用积分账户",
  other: "其他",
  user: "用户可用",
  escrow: "交易托管",
  platform: "平台账户",
  external: "外部对手账户",
};
