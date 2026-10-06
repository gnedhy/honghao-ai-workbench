type SegmentedControlProps<T extends string> = {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({ value, options, onChange, label, disabled=false }: SegmentedControlProps<T>) {
  const activeIndex = options.indexOf(value);

  return (
    <div className="segmented-control" role="tablist" aria-label={label} data-active-index={activeIndex}>
      <span className="segmented-control__indicator" aria-hidden="true" />
      {options.map((option) => (
        <button
          className={option === value ? "segmented-control__item is-active" : "segmented-control__item"}
          key={option}
          type="button"
          role="tab"
          disabled={disabled}
          aria-selected={option === value}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
