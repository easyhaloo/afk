import type { BacklogProvider } from '@afk/application';

export async function waitForTerminal(
  backlog: Pick<BacklogProvider, 'get'>,
  backlogId: string,
  loop: Promise<void>,
  timeoutMs: number,
) {
  let deadline = Date.now() + timeoutMs;
  let verificationStarted = false;
  let loopStopped = false;
  let loopFailed = false;
  let loopFailure: unknown;
  void loop.then(
    () => { loopStopped = true; },
    error => { loopFailed = true; loopFailure = error; },
  );
  while (Date.now() < deadline) {
    const current = await backlog.get(backlogId);
    if (current.state === 'merge_ready' && current.executionMode === 'hitl') return current;
    if (current.state === 'blocked' || current.state === 'done') return current;
    if (loopFailed) throw loopFailure;
    if (loopStopped) throw new Error(`loop stopped while backlog was ${current.state}`);
    if (current.state === 'verification' && !verificationStarted) {
      verificationStarted = true;
      deadline = Date.now() + timeoutMs;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(10_000, deadline - Date.now())));
  }
  throw new Error(`Codex E2E ${verificationStarted ? 'QA' : 'implementation'} phase timed out after ${timeoutMs}ms`);
}
