import { ChevronDown, Check, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ProviderIcon, type ProviderIconName } from "./ProviderIcon";

export type SelectMenuOption<T extends string> = { value: T; label: string; triggerLabel?: string; icon?: ProviderIconName };

type SelectMenuSearch<T extends string> = {
  label: string;
  pinnedValue?: T;
  emptyMessage?: string;
};

type SelectMenuProps<T extends string> = {
  label: string;
  value: T;
  options: SelectMenuOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  triggerLayout?: "default" | "center";
  variant?: "default" | "filter";
  triggerPrefix?: string;
  search?: SelectMenuSearch<T>;
};

export function SelectMenu<T extends string>({ label, value, options, onChange, disabled = false, triggerLayout = "default", variant = "default", triggerPrefix, search }: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleOptions = search
    ? options.filter((option) => option.value === search.pinnedValue || !normalizedQuery || option.label.toLowerCase().includes(normalizedQuery))
    : options;
  const hasSearchResult = visibleOptions.some((option) => option.value !== search?.pinnedValue);

  const close = (restoreFocus = false) => {
    setOpen(false);
    setSearchQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className={`select-menu${triggerLayout === "center" ? " centered-trigger" : ""}${variant === "filter" ? " filter-trigger" : ""}`} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`select-menu-trigger${open ? " open" : ""}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        value={value}
        disabled={disabled}
        title={selected?.label}
        onClick={() => { if (open) close(); else setOpen(true); }}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        <span className="select-menu-trigger-copy">
          {triggerPrefix ? <span className="select-menu-trigger-prefix">{triggerPrefix}</span> : null}
          {selected?.icon ? <ProviderIcon provider={selected.icon} size={13} /> : null}
          <span className="select-menu-trigger-value">{selected?.triggerLabel ?? selected?.label ?? label}</span>
        </span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className={`select-menu-popover${search ? " searchable" : ""}`} role={search ? undefined : "listbox"} aria-label={search ? undefined : label}>
          {search ? <label className="select-menu-search"><Search size={13} /><input autoFocus aria-label={search.label} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={search.label} /></label> : null}
          <div className="select-menu-options" role={search ? "listbox" : undefined} aria-label={search ? label : undefined}>
            {visibleOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                title={option.label}
                className={`select-menu-option${option.value === value ? " selected" : ""}${option.icon ? " icon-option" : ""}`}
                onClick={() => { onChange(option.value); close(true); }}
              >
                <span className="select-menu-option-leading">
                  {option.icon ? <ProviderIcon provider={option.icon} size={14} /> : null}
                  <span className="select-menu-option-label">{option.label}</span>
                </span>
                {option.value === value ? <Check size={14} /> : null}
              </button>
            ))}
            {search && normalizedQuery && !hasSearchResult ? <div className="select-menu-empty">{search.emptyMessage ?? "没有匹配选项"}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
