import { ChevronDown, Check, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ProviderIcon, type ProviderIconName } from "./ProviderIcon.js";

export type SelectMenuOption<T extends string> = { value: T; label: string; triggerLabel?: string; icon?: ProviderIconName; description?: string };

type SelectMenuSearch<T extends string> = {
  label: string;
  pinnedValue?: T;
  emptyMessage?: string;
};

type SelectMenuProps<T extends string> = {
  label: string;
  id?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
  value: T;
  options: SelectMenuOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  triggerLayout?: "default" | "center";
  variant?: "default" | "filter";
  triggerPrefix?: string;
  search?: SelectMenuSearch<T>;
};

export function SelectMenu<T extends string>({ label, id, required, placeholder, className, value, options, onChange, disabled = false, triggerLayout = "default", variant = "default", triggerPrefix, search }: SelectMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeValue, setActiveValue] = useState<T>(value);
  const [recentValues, setRecentValues] = useState<T[]>([]);
  const listId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pointerSelection = useRef(false);
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredOptions = search
    ? options.filter((option) => option.value === search.pinnedValue || !normalizedQuery || `${option.label} ${option.value} ${option.description ?? ""}`.toLowerCase().includes(normalizedQuery))
    : options;
  const recentOptions = search && !normalizedQuery ? recentValues.flatMap(recent => filteredOptions.filter(option => option.value === recent && option.value !== search.pinnedValue)) : [];
  const visibleOptions = recentOptions.length ? [...filteredOptions.filter(option => option.value === search?.pinnedValue), ...recentOptions, ...filteredOptions.filter(option => option.value !== search?.pinnedValue && !recentValues.includes(option.value))] : filteredOptions;
  const hasSearchResult = visibleOptions.some((option) => option.value !== search?.pinnedValue);
  const activeIndex = Math.max(0, visibleOptions.findIndex(option => option.value === activeValue));

  const show = () => { setActiveValue(value); setOpen(true); };
  const choose = (option: SelectMenuOption<T>) => {
    if (disabled) return;
    setRecentValues(current => [option.value, ...current.filter(recent => recent !== option.value)].slice(0, 3));
    onChange(option.value);
    close(true);
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    setSearchQuery("");
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (open && !search) optionRefs.current[activeIndex]?.focus();
    if (open) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeValue]);

  useEffect(() => { if (disabled) close(); }, [disabled]);

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
    <div className={`select-menu${className ? ` ${className}` : ""}${triggerLayout === "center" ? " centered-trigger" : ""}${variant === "filter" ? " filter-trigger" : ""}`} ref={menuRef} onKeyDown={event => {
      if (event.key === "Tab") { close(); return; }
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
      if (!open) { if (!disabled && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); show(); } return; }
      if (search && (event.key === "Home" || event.key === "End")) return;
      event.preventDefault();
      if (event.key === "Enter") { const option = visibleOptions[activeIndex]; if (option) choose(option); return; }
      if (!visibleOptions.length) return;
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? visibleOptions.length - 1 : (activeIndex + (event.key === "ArrowDown" ? 1 : -1) + visibleOptions.length) % visibleOptions.length;
      setActiveValue(visibleOptions[nextIndex].value);
    }}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={`select-menu-trigger${open ? " open" : ""}`}
        aria-label={label}
        aria-required={required}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        value={value}
        disabled={disabled}
        title={selected?.label}
        onClick={() => { if (open) close(); else show(); }}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        <span className="select-menu-trigger-copy">
          {triggerPrefix ? <span className="select-menu-trigger-prefix">{triggerPrefix}</span> : null}
          {selected?.icon ? <ProviderIcon provider={selected.icon} size={13} /> : null}
          <span className="select-menu-trigger-value">{selected?.triggerLabel ?? selected?.label ?? (value || placeholder || label)}</span>
        </span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className={`select-menu-popover${search ? " searchable" : ""}`} id={search ? undefined : listId} role={search ? undefined : "listbox"} aria-label={search ? undefined : label}>
          {search ? <label className="select-menu-search"><Search size={13} /><input autoFocus role="combobox" aria-expanded={open} aria-controls={listId} aria-activedescendant={visibleOptions.length ? `${listId}-${activeIndex}` : undefined} aria-label={search.label} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setActiveValue(value); }} placeholder={search.label} /></label> : null}
          <div className="select-menu-options" id={search ? listId : undefined} role={search ? "listbox" : undefined} aria-label={search ? label : undefined}>
            {visibleOptions.map((option, index) => (
              <button
                key={option.value}
                ref={element => { optionRefs.current[index] = element; }}
                id={`${listId}-${index}`}
                tabIndex={search || activeIndex !== index ? -1 : 0}
                type="button"
                role="option"
                aria-selected={option.value === value}
                title={option.label}
                className={`select-menu-option${option.value === value ? " selected" : ""}${option.icon ? " icon-option" : ""}${activeIndex === index ? " keyboard-active" : ""}${option.description || recentOptions.some(recent => recent.value === option.value) ? " has-description" : ""}`}
                onPointerDown={event => { event.preventDefault(); event.stopPropagation(); pointerSelection.current = true; choose(option); }}
                onClick={event => { event?.stopPropagation?.(); if (pointerSelection.current) { pointerSelection.current = false; return; } choose(option); }}
              >
                <span className="select-menu-option-leading">
                  {option.icon ? <ProviderIcon provider={option.icon} size={14} /> : null}
                  <span className="select-menu-option-label">{option.label}{option.description ? <small>{option.description}</small> : null}{recentOptions.some(recent => recent.value === option.value) ? <small>最近使用</small> : null}</span>
                </span>
                {option.value === value ? <Check size={14} /> : null}
              </button>
            ))}
            {search && !hasSearchResult ? <div className="select-menu-empty">{search.emptyMessage ?? "没有匹配选项"}</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
