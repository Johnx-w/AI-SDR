import type { ParseMode } from '../services/materials';
export const modeLabel = (mode: ParseMode) =>
  mode === 'asset_only'
    ? '仅登记图片或视频'
    : mode === 'quote_catalog'
      ? '图文报价清单'
      : mode === 'model_parameters'
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
        {!generalOnly && <option value="asset_only">仅登记图片或视频 · 名称、品类、关键词</option>}
        {!generalOnly && <option value="quote_catalog">图文报价清单 · 产品、配图与单价</option>}
        <option value="rich_layout_recognition">通用解析 · 文字、表格和图片</option>
        <option value="text_recognition">纯文字解析</option>
      </select>
    </label>
  );
}
