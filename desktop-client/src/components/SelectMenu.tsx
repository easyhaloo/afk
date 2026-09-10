import { ChevronDown, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type SelectMenuOption<T extends string> = { value: T; label: string };

type SelectMenuProps<T extends string> = {
  label: string;
  value: T;
  options: SelectMenuOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  align?: "start" | "center";
};

export function SelectMenu<T extends string>({ label, value, options, onChange, disabled = false, align = "start" }: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="select-menu" ref={menuRef}>
      <button
        type="button"
        className={`select-menu-trigger${open ? " open" : ""}${align === "center" ? " centered" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        value={value}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        <span>{selected?.label ?? label}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="select-menu-popover" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-menu-option${option.value === value ? " selected" : ""}${align === "center" ? " centered" : ""}`}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span>{option.label}</span>
              {option.value === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
