import type { ParseMode } from '../services/materials';
export const modeLabel = (mode: ParseMode) =>
  mode === 'model_parameters'
    ? '型号参数'
    : mode === 'text_recognition'
      ? '纯文字解析'
      : '图文解析';
export function MaterialParseMode({
  value,
  onChange,
  disabled,
  generalOnly = false,
}: {
  value: ParseMode;
  onChange: (mode: ParseMode) => void;
  disabled?: boolean;
  generalOnly?: boolean;
}) {
  return (
    <label className="kb-parse-mode">
      文档解析方式
      <select
        aria-label="文档解析方式"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ParseMode)}
      >
        {!generalOnly && <option value="model_parameters">型号参数 · 用于自动回复</option>}
        <option value="rich_layout_recognition">图文解析 · 含图表与图片</option>
        <option value="text_recognition">纯文字解析</option>
      </select>
    </label>
  );
}
