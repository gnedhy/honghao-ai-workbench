// Presentation validation only; the server remains authoritative.
export function aiAmountError(value: string, maximum: number, optional: boolean): string {
  if (value === '') return optional ? '' : '请填写金额';
  const parts = value.match(/^(?:\d+(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i);
  if (!parts || !Number.isFinite(Number(value)) || Number(value) < 0) return '请输入有效非负金额';
  if (Number(value) > maximum) return `金额不能超过 ${maximum.toLocaleString('zh-CN')} 元`;
  if ((parts[1]?.length ?? parts[2]?.length ?? 0) - Number(parts[3] ?? 0) > 12) return '金额最多支持十二位小数';
  return '';
}

export function queueElapsed(start: string | null, readAt: number | null): string {
  if (!start || !readAt || !Number.isFinite(Date.parse(start))) return '—';
  const seconds = Math.max(0, Math.floor((readAt - Date.parse(start)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
