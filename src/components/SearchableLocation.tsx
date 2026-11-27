import Select, { createFilter, type Theme } from 'react-select';
import './SearchableLocation.css';
export type LocationOption = { value: string; label: string; keywords?: string };
const filterOption = createFilter<LocationOption>({
  stringify: ({ data }) => [data.label, data.value, data.keywords].filter(Boolean).join(' '),
});
type LocationProps = {
  label: string;
  id: string;
  options: readonly LocationOption[];
  disabled?: boolean;
} & (
  | { multiple?: false; value: string; onChange: (value: string) => void }
  | { multiple: true; value: string[]; onChange: (value: string[]) => void }
);

export function SearchableLocation(props: LocationProps) {
  const { id, label, options, disabled } = props;
  const shared = {
    instanceId: id,
    inputId: id,
    'aria-label': label,
    className: 'location-select',
    classNamePrefix: 'geo',
    isDisabled: disabled,
    options,
    filterOption,
    noOptionsMessage: () => '没有匹配的选项',
    menuPlacement: 'auto' as const,
    theme: (theme: Theme) => ({
      ...theme,
      colors: {
        ...theme.colors,
        primary: 'var(--color-primary)',
        primary25: 'var(--color-primary-soft)',
      },
    }),
  };
  if (props.multiple) {
    return (
      <Select<LocationOption, true>
        {...shared}
        isMulti
        placeholder="全部市场"
        value={props.value.map(
          (value) => options.find((item) => item.value === value) || { value, label: value },
        )}
        onChange={(selected) => props.onChange(selected.map((item) => item.value))}
      />
    );
  }
  return (
    <Select<LocationOption, false>
      {...shared}
      placeholder={'请选择' + label}
      value={options.find((item) => item.value === props.value) || null}
      onChange={(option) => option && props.onChange(option.value)}
    />
  );
}
