import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export function FilterPanel({ label, filters, children }: { label: string; filters: Array<{ key: string; label: string; onClear: () => void }>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const dismiss = (event: MouseEvent) => { if (container.current && !container.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);
  return <div className="selection-filters" ref={container} onKeyDown={event => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    trigger.current?.focus();
  }}>
    <button ref={trigger} type="button" className={`selection-filter-trigger${filters.length ? " active" : ""}`} aria-label={label} title={label} aria-controls={panelId} aria-expanded={open} onClick={() => setOpen(current => !current)}><SlidersHorizontal size={15} />{filters.length ? <span>{filters.length}</span> : null}</button>
    <div className="selection-filter-panel" id={panelId} role="group" aria-label="筛选条件" hidden={!open}>{children}</div>
    {filters.length ? <div className="selection-filter-chips" aria-label="已启用筛选">{filters.map(filter => <button key={filter.key} type="button" aria-label={`移除筛选：${filter.label}`} onClick={filter.onClear}>{filter.label}<X size={12} /></button>)}<button type="button" onClick={() => filters.forEach(filter => filter.onClear())}>清除全部</button></div> : null}
  </div>;
}
