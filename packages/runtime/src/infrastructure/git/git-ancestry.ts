import type { SimpleGit } from 'simple-git';

/**
 * Whether `ancestor` is contained in `descendant` — that is, whether the
 * second commit contains the first.
 *
 * `git merge-base --is-ancestor` is the direct answer, but it reports "no" by
 * exiting with a status code and printing nothing at all. A git client that
 * decides failure by looking for an error message never sees one, so the
 * command comes back as a success with empty output — and the answer becomes
 * "yes" for every pair of commits. The merge base is the answer git does
 * print: the first commit is contained in the second exactly when the merge
 * base of the two is the first commit.
 */
export async function isAncestorCommit(git: SimpleGit, ancestor: string, descendant: string): Promise<boolean> {
  let bases: string[];
  try {
    bases = (await git.raw(['merge-base', '--all', ancestor, descendant]))
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    // Commits that share no history have no merge base at all.
    return false;
  }
  return bases.includes(ancestor);
}
