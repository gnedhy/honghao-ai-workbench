type SegmentedControlProps<T extends string> = {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
};

export function SegmentedControl<T extends string>({ value, options, onChange, label, disabled=false }: SegmentedControlProps<T>) {
  const activeIndex = options.indexOf(value);
  const count = options.length;

  return (
    <div className="segmented-control" role="tablist" aria-label={label} data-active-index={activeIndex} style={{gridTemplateColumns:`repeat(${count}, minmax(0, 1fr))`}}>
      <span className="segmented-control__indicator" aria-hidden="true" style={{width:`calc((100% - ${6+2*(count-1)}px) / ${count})`,transform:`translateX(calc(${activeIndex*100}% + ${activeIndex*2}px))`}}/>
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
