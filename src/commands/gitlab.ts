import { Command } from 'commander';
import chalk from 'chalk';
import { GitLabClient } from '../lib/gitlab.js';

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
        const client = createClient();
        const issue = await client.getIssue(parseInt(iid));

        if (options.json) {
          console.log(JSON.stringify(issue, null, 2));
        } else {
          console.log(chalk.bold(`#${issue.iid}: ${issue.title}`));
          console.log(chalk.gray(`State: ${issue.state}`));
          console.log(chalk.gray(`Labels: ${issue.labels.join(', ')}`));
          console.log(chalk.gray(`URL: ${issue.web_url}`));
          console.log();
          console.log(chalk.dim(issue.description));
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
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
            console.log(`  ${chalk.cyan(`#${issue.iid}`)} ${issue.title} ${labels}`);
          });
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        await client.addLabel(parseInt(iid), label);
        console.log(chalk.green(`✓ Added label "${label}" to issue #${iid}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        await client.removeLabel(parseInt(iid), label);
        console.log(chalk.green(`✓ Removed label "${label}" from issue #${iid}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        await client.addComment(parseInt(iid), message);
        console.log(chalk.green(`✓ Added comment to issue #${iid}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        const issue = await client.getIssue(parseInt(iid));
        const ac = client.parseAC(issue.description);

        if (!ac) {
          console.log(chalk.yellow('No AC section found in issue description'));
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(ac, null, 2));
        } else {
          console.log(chalk.bold('Acceptance Criteria:'));
          console.log();
          ac.items.forEach((item, i) => {
            console.log(`  ${i + 1}. ${item}`);
          });
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        const add = options.add ? options.add.split(',').map((l: string) => l.trim()) : [];
        const remove = options.remove ? options.remove.split(',').map((l: string) => l.trim()) : [];
        await client.updateLabelsBatch(parseInt(iid), add, remove);
        console.log(chalk.green(`✓ Updated labels on issue #${iid}`));
        if (add.length) console.log(chalk.gray(`  + ${add.join(', ')}`));
        if (remove.length) console.log(chalk.gray(`  - ${remove.join(', ')}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        await client.addMRComment(parseInt(mriid), message, { resolvable: options.resolvable });
        console.log(chalk.green(`✓ Added comment to MR !${mriid}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        const linkType = options.isBlockedBy ? 'is_blocked_by' : 'blocks';
        await client.linkIssues(
          parseInt(sourceIid),
          parseInt(targetIid),
          linkType
        );
        console.log(chalk.green(`✓ Linked #${sourceIid} ${linkType} #${targetIid}`));
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
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
        const client = createClient();
        const status = await client.getMRPipelineStatus(parseInt(mriid));
        console.log(status);
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
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
        const client = createClient();
        const markdown = await client.uploadArtifacts(worktree);
        if (markdown) {
          console.log(markdown);
        } else {
          console.log(chalk.gray('No artifacts to upload (or .afk/artifacts.txt not found)'));
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Create GitLab client from environment variables
 */
function createClient(): GitLabClient {
  const url = process.env.GITLAB_URL || 'https://gitlab.com';
  const token = process.env.GITLAB_TOKEN;
  const projectId = process.env.GITLAB_PROJECT_ID;

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable is required');
  }

  if (!projectId) {
    throw new Error('GITLAB_PROJECT_ID environment variable is required');
  }

  return new GitLabClient({ url, token, projectId });
}
