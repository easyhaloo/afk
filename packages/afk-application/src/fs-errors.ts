/**
 * The file system's "no such file" answer.
 *
 * A reader that has to tell "the file is not there" from "the file is
 * there and reading it failed" asks this, because the two failures need
 * different answers.  Two readers were asking it by hand.
 */
export function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
