import { CommandVerificationProvider, type CommandVerificationOptions } from './command.js';

export { runVerificationCommand } from './command.js';
export type { CommandVerificationOptions, VerificationCommandOptions, VerificationCommandResult, VerificationCommandRunner } from './command.js';

export class TestRunnerVerificationProvider extends CommandVerificationProvider {
  constructor(options: CommandVerificationOptions = {}) {
    super('test-runner', 'test-execution', ['npm', 'test'], options);
  }
}

export class StaticScanVerificationProvider extends CommandVerificationProvider {
  constructor(options: CommandVerificationOptions = {}) {
    super('static-scan', 'static-analysis', ['npm', 'run', 'lint'], options);
  }
}

export class BrowserCheckVerificationProvider extends CommandVerificationProvider {
  constructor(options: CommandVerificationOptions = {}) {
    super('browser-check', 'test-execution', ['playwright', 'test'], options);
  }
}
