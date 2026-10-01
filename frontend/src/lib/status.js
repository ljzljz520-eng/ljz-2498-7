export const statusLabels = {
  prepared: { label: '已准备', tone: 'neutral' },
  attempted_delivery: { label: '已尝试投递', tone: 'warning' },
  confirmed_receipt: { label: '已确认回执', tone: 'ok' },
  retryable: { label: '等待重试', tone: 'warning' },
  skipped_unsubscribed: { label: '未订阅跳过', tone: 'neutral' },
  skipped_after_claim: { label: '领取后退订跳过', tone: 'neutral' },
  skipped_after_attempt: { label: '尝试后退订', tone: 'neutral' },
  failed_permanent: { label: '永久失败', tone: 'bad' },
  failed_retry_exhausted: { label: '重试耗尽', tone: 'bad' },
};

export function statusLabel(status) {
  return statusLabels[status]?.label ?? status;
}
