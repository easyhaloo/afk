/**
 * The rules a work item run's branch and checkout path have to satisfy.
 *
 * A branch name becomes a git ref and a checkout path becomes a directory
 * under the execution workspace, and either of them may end up on a
 * filesystem that is not the one the run was started on.  The rules are
 * the same wherever the input comes from — the desktop's run panel, the
 * execution manifest — so they are written once here rather than once per
 * caller, which is how two copies of them drifted apart in the first
 * place.
 */

const WINDOWS_RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * A branch name that git will accept as a ref and that no shell will
 * misread.
 */
export function validateBaseBranch(value: unknown, label = "baseBranch"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) throw new Error(`${label} is invalid`);
  const segments = value.split("/");
  if (
    value === "@"
    || value.includes("..")
    || value.includes("@{")
    || value.includes("//")
    || /[\\ ~^:?*[\x00-\x1f\x7f]/.test(value)
    || segments.some(segment => !segment || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/**
 * A checkout path that stays inside the execution workspace and that is
 * portable: the same directory on every platform the run may land on.
 */
export function validateCheckoutPath(value: unknown, label = "checkoutPath"): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is invalid`);
  if (/^[A-Za-z]:/.test(value)) throw new Error(`${label} must not use a drive prefix`);
  if (value.startsWith("/") || value.startsWith("\\")) throw new Error(`${label} must be relative`);
  if (value.endsWith("/") || value.endsWith("\\")) throw new Error(`${label} must not end with a separator`);
  const segments = value.replace(/\\/g, "/").split("/");
  if (segments.some(segment => segment === "." || segment === "..")) throw new Error(`${label} must not traverse directories`);
  if (segments.some(segment => segment.endsWith(".") || segment.endsWith(" "))) throw new Error(`${label} has a non-portable path segment`);
  if (segments.some(segment => /[<>:"|?*]/.test(segment))) throw new Error(`${label} contains an invalid Windows path character`);
  if (segments.some(segment => WINDOWS_RESERVED_DEVICE_NAME.test(segment))) throw new Error(`${label} uses a reserved Windows device name`);
  return value;
}
