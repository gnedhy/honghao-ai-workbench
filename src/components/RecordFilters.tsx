import styles from "./RecordFilters.module.css";

export function RecordFilters({ label, options, value, onChange }: { label: string; options: { value: string; label: string; count: number }[]; value: string; onChange: (value: string) => void }) {
  return <div className={styles.root} role="group" aria-label={label}>{options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}<span>{option.count}</span></button>)}</div>;
}
