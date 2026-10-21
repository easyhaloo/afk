/**
 * What an agent's run cost in tokens.
 *
 * The number is read out of the harness's own transcript, never counted
 * here: AFK reports what the harness said it used. The shape lives in the
 * core package because the telemetry reader, the retro that reports on it
 * and the desktop that shows it are three layers that must agree on what
 * "the tokens an agent used" means.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
