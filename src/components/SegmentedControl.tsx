type SegmentedControlProps<T extends string> = {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
};

export function SegmentedControl<T extends string>({ value, options, onChange, label }: SegmentedControlProps<T>) {
  return (
    <div className="segmented-control" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          className={option === value ? "segmented-control__item is-active" : "segmented-control__item"}
          key={option}
          type="button"
          role="tab"
          aria-selected={option === value}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
