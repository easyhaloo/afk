/**
 * Which backticked paths in a document are claims about source.
 *
 * A document that names a source file makes a claim that the file exists:
 * moving a module without correcting the documents that name it leaves a
 * claim nobody is checking. That claim is worth making — but only about
 * source.
 *
 * Build output is not source. `dist/`, `dist-electron/` and `release/` hold
 * generated artifacts, and a document may legitimately name the artifact a
 * build produces. That file does not exist until the build runs, so
 * demanding it would fail the check on a clean checkout and pass only on a
 * machine that happened to build first.
 */
export const GENERATED_OUTPUT_ROOTS = ['dist', 'dist-electron', 'release'];

/**
 * Whether a path names a generated artifact rather than a source file.
 *
 * The root may appear anywhere in the path, because a document may name the
 * artifact relative to the repository root or to the desktop client.
 */
export function isGeneratedOutputPath(raw) {
  return raw.split('/').some((segment) => GENERATED_OUTPUT_ROOTS.includes(segment));
}
