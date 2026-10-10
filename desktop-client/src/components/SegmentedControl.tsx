import { useRef } from "react";

type Segment<T extends string> = { value: T; label: string; count?: number };

export function SegmentedControl<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: T;
  options: Segment<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return <div className="selection-segments" role="radiogroup" aria-label={label}>
    {options.map((option, index) => <button key={option.value} ref={element => { buttons.current[index] = element; }} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value || (!options.some(candidate => candidate.value === value) && index === 0) ? 0 : -1} disabled={disabled} className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)} onKeyDown={event => {
      if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      onChange(options[nextIndex].value);
      buttons.current[nextIndex]?.focus();
    }}>{option.label}{option.count !== undefined ? <span>{option.count}</span> : null}</button>)}
  </div>;
}
