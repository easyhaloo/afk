export function isWorkItemProjectKey(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[#\s\x00-\x1f\x7f]/.test(value)) return false;
  const [host, ...path] = value.split('/');
  if ([host, ...path].some(segment => !segment || segment === '.' || segment === '..')) return false;
  if (path.some(segment => segment.includes(':'))) return false;
  if (!host.includes(':')) return true;
  return path.length > 0 && /^[^:]+:[1-9]\d{0,4}$/.test(host) && Number(host.split(':')[1]) <= 65535;
}
