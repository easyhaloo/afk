/**
 * Which loop status snapshot the desktop card shows.
 *
 * A machine may run one loop per work item, each filed under its own tag. A
 * run does not delete its status file when it exits, so presence alone says
 * nothing: a finished `default` run would otherwise shadow a loop that is
 * working right now, and the card would read `stopped` while `afk loop status`
 * says `running`.
 *
 * Kept free of Electron and filesystem access so the ordering rules can be
 * tested directly; the caller supplies the candidates it managed to read.
 */
export interface LoopStatusCandidate {
  /** Run tag, or `legacy` for the previous single-loop layout. */
  readonly tag: string;
  readonly raw: string;
  readonly modifiedAt: number;
}

/** Pick the snapshot an operator would look at first. */
export function selectLoopStatusCandidate(
  candidates: readonly LoopStatusCandidate[],
  isAlive: (pid: number) => boolean,
): LoopStatusCandidate | undefined {
  const newest = (pool: readonly LoopStatusCandidate[]) => [...pool].sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
  const live = candidates.filter(candidate => {
    const pid = pidOf(candidate.raw);
    return pid !== undefined && isAlive(pid);
  });
  return live.find(candidate => candidate.tag === "default")
    ?? newest(live)
    ?? candidates.find(candidate => candidate.tag === "default")
    ?? newest(candidates);
}

/** The pid a snapshot claims, when it claims a plausible one. */
function pidOf(raw: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
