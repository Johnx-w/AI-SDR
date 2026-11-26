import { useState } from 'react';

export function PriceAmount({
  value,
  label,
  commit,
  notify,
  writable,
}: {
  value: string;
  label: string;
  commit: (value: string) => void;
  notify: (message: string) => void;
  writable: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={value.length > 9 ? 'pc-amount pc-long' : 'pc-amount'}
      aria-label={label}
      title={'点击修改 ' + label}
      type="text"
      readOnly={!writable}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      value={draft ?? value}
      placeholder="待报价"
      onFocus={(e) => {
        setDraft(value);
        e.currentTarget.select();
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        const amount = e.currentTarget.value.trim();
        setDraft(null);
        if (amount === value) return;
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount) || !Number.isFinite(Number(amount))) {
          notify('请输入有效的非负金额，已恢复原值');
          return;
        }
        commit(amount);
      }}
    />
  );
}
