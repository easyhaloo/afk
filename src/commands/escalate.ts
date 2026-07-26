import { Command } from 'commander';
import { spawn } from 'child_process';
import { detectGitLabProject } from '../lib/gitlab.js';
import { getGlabToken } from '../lib/glab-config.js';

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
        console.error('ERROR: empty issue body. Provide via stdin or as second arg.');
        process.exit(1);
      }

      // Build labels
      const labels = ['mode::afk', 'stage::ready-for-issues'];
      if (options.prdIid) {
        labels.push(`base::prd-${options.prdIid}`);
      }

      console.log('Filing GitLab issue...');

      // Detect project from git remote
      const projectPath = await detectGitLabProject();
      if (!projectPath) {
        console.error('ERROR: could not detect project from git remote. Set GITLAB_PROJECT_ID.');
        process.exit(1);
      }

      // Resolve token: env > glab config
      const envUrl = process.env.GITLAB_URL;
      let token = process.env.GITLAB_TOKEN;
      let url = envUrl || 'https://gitlab.com';
      if (!token) {
        const glab = getGlabToken(envUrl);
        if (glab) {
          url = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
          token = glab.token;
        }
      }
      if (!token) {
        console.error('ERROR: GITLAB_TOKEN not set and glab not authenticated.');
        process.exit(1);
      }

      const { Gitlab } = await import('@gitbeaker/node');
      const gitlab = new Gitlab({ host: url, token });

      const issue = await gitlab.Issues.create(projectPath, {
        title,
        description: body,
        labels: labels.join(','),
      }) as any;

      const iid = issue.iid;
      console.log(`Created issue #${iid}: ${title}`);

      // Optionally launch afk workflow
      if (options.launch) {
        console.log('Launching afk workflow in background...');
        const proc = spawn('afk', ['workflow', 'run', '--iid', String(iid)], {
          detached: true,
          stdio: 'ignore',
        });
        proc.unref();
        console.log(`Launched (pid=${proc.pid}). Monitor with: tmux attach -t afk`);
      }

      console.log('\nIssue is now labeled mode::afk + stage::ready-for-issues.');
      console.log('Scheduler (auto mode) or manual /afk-implement will pick it up.');
    });
}
