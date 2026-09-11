import { Command } from 'commander';
import { spawn } from 'child_process';
import { createGitLabClient } from '../lib/client-factory';
import { handleCommandError, success, info, detail } from '../lib/cli-utils';

export function registerEscalateCommands(program: Command): void {
  const escalate = program
    .command('escalate')
    .description('File a GitLab issue and optionally launch afk workflow');

  /**
   * escalate create
   * Files a GitLab issue with mode::afk + stage::ready-for-issues labels,
   * then optionally launches afk workflow in background.
   */
  escalate
    .command('create')
    .description('File an AFK-labeled GitLab issue from a title and body')
    .argument('<title>', 'Issue title')
    .argument('[body-file]', 'File containing issue body (default: stdin)')
    .option('--prd-iid <n>', 'Link to PRD issue via base::prd-N label')
    .option('--launch', 'Also launch afk workflow in background tmux session')
    .action(async (title: string, bodyFile: string | undefined, options) => {
      // Read body
      let body = '';
      if (bodyFile) {
        const { promises: fs } = await import('fs');
        body = await fs.readFile(bodyFile, 'utf-8');
      } else if (!process.stdin.isTTY) {
        // Read from stdin
        const { promises: fs } = await import('fs');
        body = await fs.readFile('/dev/stdin', 'utf-8');
      }
      if (!body.trim()) {
        handleCommandError(new Error('empty issue body. Provide via stdin or as second arg.'));
      }

      // Build labels
      const labels = ['mode::afk', 'stage::ready-for-issues'];
      if (options.prdIid) {
        labels.push(`base::prd-${options.prdIid}`);
      }

      info('Filing GitLab issue...');

      try {
        // Route through the TrackerProvider seam instead of constructing a raw
        // gitbeaker client: createGitLabClient() resolves env > glab CLI > git
        // remote, and createIssue() handles the labels array + returns the iid.
        const tracker = await createGitLabClient();
        const iid = await tracker.createIssue({ title, description: body, labels });
        success(`Created issue #${iid}: ${title}`);

        // Optionally launch afk workflow
        if (options.launch) {
          info('Launching afk workflow in background...');
          const proc = spawn('afk', ['workflow', 'run', '--iid', String(iid)], {
            detached: true,
            stdio: 'ignore',
          });
          proc.unref();
          info(`Launched (pid=${proc.pid}). Monitor with: tmux attach -t afk`);
        }

        info('Issue is now labeled mode::afk + stage::ready-for-issues.');
        detail('Scheduler (auto mode) or manual /afk-implement will pick it up.');
      } catch (error) {
        handleCommandError(error);
      }
    });
}
