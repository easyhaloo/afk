import { Search } from "lucide-react";

export function ResourceSearch({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="resource-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} /></label>;
}
