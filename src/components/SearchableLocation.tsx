import Select, { createFilter } from 'react-select';
import './SearchableLocation.css';
export type LocationOption = { value: string; label: string; keywords?: string };
const filterOption = createFilter<LocationOption>({
  stringify: ({ data }) => [data.label, data.value, data.keywords].filter(Boolean).join(' '),
});
export function SearchableLocation({
  label,
  id,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  id: string;
  options: readonly LocationOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = options.find((item) => item.value === value) || null;
  return (
    <Select<LocationOption, false>
      instanceId={id}
      inputId={id}
      aria-label={label}
      className="location-select"
      classNamePrefix="geo"
      isDisabled={disabled}
      isSearchable
      options={options}
      value={selected}
      placeholder={'请选择' + label}
      filterOption={filterOption}
      onChange={(option) => option && onChange(option.value)}
      noOptionsMessage={() => '没有匹配的选项'}
      menuPlacement="auto"
      theme={(theme) => ({
        ...theme,
        colors: {
          ...theme.colors,
          primary: 'var(--color-primary)',
          primary25: 'var(--color-primary-soft)',
        },
      })}
    />
  );
}
