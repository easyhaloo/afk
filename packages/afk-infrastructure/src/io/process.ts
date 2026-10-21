/**
 * Whether a process with this pid exists.
 *
 * `true` says it exists, `false` says it is gone, and `undefined` says we
 * could not tell.
 *
 * The third answer is the point. A caller that acts on "the process is
 * gone" has to decide what an inconclusive probe means, and a caller
 * that reads it as "gone" ends a run that is still running.
 */
export function probeProcess(pid: number): boolean | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: no such process. EPERM: the process exists and we are not
    // allowed to signal it - which still makes it alive.
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}
