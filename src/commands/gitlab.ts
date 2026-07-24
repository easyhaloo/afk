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
