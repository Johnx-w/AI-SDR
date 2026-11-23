import type { ParseMode } from '../services/materials';
export const modeLabel = (mode: ParseMode) =>
  mode === 'text_recognition' ? '纯文字解析' : '图文解析';
export function MaterialParseMode({
  value,
  onChange,
  disabled,
}: {
  value: ParseMode;
  onChange: (mode: ParseMode) => void;
  disabled?: boolean;
}) {
  return (
    <label className="kb-parse-mode">
      文档解析方式
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ParseMode)}
      >
        <option value="rich_layout_recognition">图文解析 · 含图表与图片</option>
        <option value="text_recognition">纯文字解析</option>
      </select>
    </label>
  );
}
