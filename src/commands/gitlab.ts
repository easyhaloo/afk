import { Command } from 'commander';
import chalk from 'chalk';
import { createGitLabClient } from '../lib/client-factory';
import { detectGitLabProject } from '../lib/core/tracker/detect';
import { getGlabToken } from '../lib/core/gitlab/glab-config';
import { handleCommandError, parseCommaSeparated, formatJson } from '../lib/cli-utils';

export function registerGitLabCommands(program: Command): void {
  const gitlab = program
    .command('gitlab')
    .description('GitLab operations (issues, MRs, labels)');

  /**
   * get-issue command
   */
  gitlab
    .command('get-issue')
    .description('Get issue by IID')
    .argument('<iid>', 'Issue IID')
    .option('--json', 'Output as JSON')
    .action(async (iid: string, options) => {
      try {
        const client = await createGitLabClient();
        const issue = await client.getIssue(parseInt(iid));

        if (options.json) {
          console.log(JSON.stringify(issue, null, 2));
        } else {
          console.log(chalk.bold(`#${issue.id}: ${issue.title}`));
          console.log(chalk.gray(`State: ${issue.state}`));
          console.log(chalk.gray(`Labels: ${issue.labels.join(', ')}`));
          console.log(chalk.gray(`URL: ${issue.url}`));
          console.log();
          console.log(chalk.dim(issue.description));
        }
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * list-issues command
   */
  gitlab
    .command('list-issues')
    .description('List issues with filters')
    .option('-l, --label <labels...>', 'Filter by labels')
    .option('-s, --state <state>', 'Filter by state (opened, closed, all)', 'opened')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const client = await createGitLabClient();
        const issues = await client.listIssues({
          labels: options.label,
          state: options.state,
        });

        if (options.json) {
          console.log(JSON.stringify(issues, null, 2));
        } else {
          console.log(chalk.bold(`Found ${issues.length} issues:`));
          console.log();
          issues.forEach(issue => {
            const labels = issue.labels.length > 0
              ? chalk.gray(`[${issue.labels.join(', ')}]`)
              : '';
            console.log(`  ${chalk.cyan(`#${issue.id}`)} ${issue.title} ${labels}`);
          });
        }
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * add-label command
   */
  gitlab
    .command('add-label')
    .description('Add label to issue')
    .argument('<iid>', 'Issue IID')
    .argument('<label>', 'Label to add')
    .action(async (iid: string, label: string) => {
      try {
        const client = await createGitLabClient();
        await client.addLabel(parseInt(iid), label);
        console.log(chalk.green(`✓ Added label "${label}" to issue #${iid}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * remove-label command
   */
  gitlab
    .command('remove-label')
    .description('Remove label from issue')
    .argument('<iid>', 'Issue IID')
    .argument('<label>', 'Label to remove')
    .action(async (iid: string, label: string) => {
      try {
        const client = await createGitLabClient();
        await client.removeLabel(parseInt(iid), label);
        console.log(chalk.green(`✓ Removed label "${label}" from issue #${iid}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * add-comment command
   */
  gitlab
    .command('add-comment')
    .description('Add comment to issue')
    .argument('<iid>', 'Issue IID')
    .argument('<message>', 'Comment message')
    .action(async (iid: string, message: string) => {
      try {
        const client = await createGitLabClient();
        await client.addComment(parseInt(iid), message);
        console.log(chalk.green(`✓ Added comment to issue #${iid}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * issue-create command
   */
  gitlab
    .command('issue-create')
    .description('Create a new GitLab issue')
    .argument('<title>', 'Issue title')
    .option('--description <text>', 'Issue description')
    .option('--label <labels>', 'Comma-separated labels')
    .action(async (title: string, options) => {
      try {
        const client = await createGitLabClient();
        const iid = await client.createIssue({
          title,
          description: options.description,
          labels: options.label ? parseCommaSeparated(options.label) : [],
        });
        console.log(chalk.green(`✓ Created issue #${iid}: ${title}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * issue-update command
   */
  gitlab
    .command('issue-update')
    .description('Update issue labels (add)')
    .argument('<iid>', 'Issue IID')
    .option('--add-label <labels>', 'Comma-separated labels to add')
    .action(async (iid: string, options) => {
      try {
        const client = await createGitLabClient();
        if (options.addLabel) {
          const labels = parseCommaSeparated(options.addLabel);
          await client.addLabelsToIssue(parseInt(iid), labels);
          console.log(chalk.green(`✓ Added labels to issue #${iid}: ${options.addLabel}`));
        } else {
          console.log(chalk.yellow('No labels to add. Use --add-label.'));
        }
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * parse-ac command
   */
  gitlab
    .command('parse-ac')
    .description('Parse acceptance criteria from issue description')
    .argument('<iid>', 'Issue IID')
    .option('--json', 'Output as JSON')
    .action(async (iid: string, options) => {
      try {
        const client = await createGitLabClient();
        const issue = await client.getIssue(parseInt(iid));
        const ac = client.parseAC(issue);

        if (ac.items.length === 0) {
          console.log(chalk.yellow('No AC found (add ac::1::... labels or ## AC markdown section)'));
          process.exit(1);
        }

        const sourceHint = ac.source === 'labels' ? '(from labels)' : '(from legacy markdown)';
        if (options.json) {
          console.log(JSON.stringify(ac, null, 2));
        } else {
          console.log(chalk.bold(`Acceptance Criteria ${sourceHint}:`));
          console.log();
          ac.items.forEach((item) => {
            const evidence = item.evidenceType !== 'none'
              ? `  [${item.evidenceType}] ${item.checkCommand}`
              : '';
            console.log(`  ${item.index}. ${item.text}${evidence}`);
          });
        }
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * update-labels command — add and/or remove labels in one call
   */
  gitlab
    .command('update-labels')
    .description('Add and/or remove labels from an issue')
    .argument('<iid>', 'Issue IID')
    .option('--add <labels>', 'Comma-separated labels to add')
    .option('--remove <labels>', 'Comma-separated labels to remove')
    .action(async (iid: string, options) => {
      try {
        const client = await createGitLabClient();
        const add = options.add ? parseCommaSeparated(options.add) : [];
        const remove = options.remove ? parseCommaSeparated(options.remove) : [];
        await client.updateLabelsBatch(parseInt(iid), add, remove);
        console.log(chalk.green(`✓ Updated labels on issue #${iid}`));
        if (add.length) console.log(chalk.gray(`  + ${add.join(', ')}`));
        if (remove.length) console.log(chalk.gray(`  - ${remove.join(', ')}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * add-mr-comment command
   */
  gitlab
    .command('add-mr-comment')
    .description('Add comment to merge request')
    .argument('<mriid>', 'Merge Request IID')
    .argument('<message>', 'Comment message')
    .option('--resolvable', 'Mark comment as resolvable')
    .action(async (mriid: string, message: string, options) => {
      try {
        const client = await createGitLabClient();
        await client.addMRComment(parseInt(mriid), message, { resolvable: options.resolvable });
        console.log(chalk.green(`✓ Added comment to MR !${mriid}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * link-issues command
   */
  gitlab
    .command('link-issues')
    .description('Link two issues with a blocks / is_blocked_by relationship')
    .argument('<source-iid>', 'Source issue IID (the blocker)')
    .argument('<target-iid>', 'Target issue IID (the blocked issue)')
    .option('--is-blocked-by', 'Reverse: source is blocked by target instead of blocks')
    .action(async (sourceIid: string, targetIid: string, options) => {
      try {
        const client = await createGitLabClient();
        const linkType = options.isBlockedBy ? 'is_blocked_by' : 'blocks';
        await client.linkIssues(
          parseInt(sourceIid),
          parseInt(targetIid),
          linkType
        );
        console.log(chalk.green(`✓ Linked #${sourceIid} ${linkType} #${targetIid}`));
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * pipeline-status command
   */
  gitlab
    .command('pipeline-status')
    .description('Get head pipeline status for a merge request')
    .argument('<mriid>', 'Merge Request IID')
    .action(async (mriid: string) => {
      try {
        const client = await createGitLabClient();
        const status = await client.getMRPipelineStatus(parseInt(mriid));
        console.log(status);
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });

  /**
   * open command
   */
  gitlab
    .command('open <type> <iid>')
    .description('Open an issue or MR in the browser')
    .action(async (type: string, iid: string) => {
      if (type !== 'issue' && type !== 'mr') {
        console.error('Usage: afk gitlab open <issue|mr> <iid>');
        process.exit(1);
      }

      // Resolve base URL and project path from env, glab config, or git remote
      const envUrl = process.env.GITLAB_URL;
      let baseUrl = envUrl || 'https://gitlab.com';
      let projectPath = process.env.GITLAB_PROJECT_ID || '';

      if (!projectPath) {
        const detected = await detectGitLabProject();
        if (detected) projectPath = detected;
      }
      if (!envUrl) {
        const glab = getGlabToken();
        if (glab) {
          baseUrl = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
        }
      }

      const num = parseInt(iid);
      if (isNaN(num)) { console.error('Invalid IID'); process.exit(1); }
      if (!projectPath) { console.error('Could not determine project. Set GITLAB_PROJECT_ID or run from git repo.'); process.exit(1); }

      // GitLab web URL format: host/project/-/issues|merge_requests/:iid
      const suffix = type === 'issue' ? `/-/issues/${num}` : `/-/merge_requests/${num}`;
      const openUrl = `${baseUrl.replace(/\/$/, '')}/${projectPath}${suffix}`;

      const { default: open } = await import('open');
      await open(openUrl);
      console.log(chalk.green(`Opened ${type} #${iid} → ${openUrl}`));
    });

  /**
   * upload-artifacts command
   */
  gitlab
    .command('upload-artifacts')
    .description('Upload files listed in .afk/artifacts.txt from a worktree')
    .argument('<worktree>', 'Path to worktree')
    .action(async (worktree: string) => {
      try {
        const client = await createGitLabClient();
        const markdown = await client.uploadArtifacts(worktree);
        if (markdown) {
          console.log(markdown);
        } else {
          console.log(chalk.gray('No artifacts to upload (or .afk/artifacts.txt not found)'));
        }
      } catch (error) {
        handleCommandError(error);
        process.exit(1);
      }
    });
}
