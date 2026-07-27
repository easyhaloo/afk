import { Command } from 'commander';
import chalk from 'chalk';
import { GitHubClient } from '../lib/core/github/client.js';
import { detectGitHubRepo } from '../lib/core/tracker/detect.js';
import { execSync } from 'child_process';

/**
 * Parse comma-separated string into trimmed array
 */
function parseLabels(input: string): string[] {
  return input.split(',').map(l => l.trim());
}

/**
 * Handle command error and exit
 */
function handleError(error: unknown): never {
  console.error(chalk.red('Error:'), (error as Error).message);
  process.exit(1);
}

export function registerGitHubCommands(program: Command): void {
  const github = program
    .command('github')
    .description('GitHub operations (issues, labels)');

  /**
   * get-issue command
   */
  github
    .command('get-issue')
    .description('Get issue by number')
    .argument('<number>', 'Issue number')
    .option('--json', 'Output as JSON')
    .action(async (number: string, options) => {
      try {
        const client = await createClient();
        const issue = await client.getIssue(parseInt(number));

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
        handleError(error);
      }
    });

  /**
   * list-issues command
   */
  github
    .command('list-issues')
    .description('List issues with filters')
    .option('-l, --label <labels...>', 'Filter by labels')
    .option('-s, --state <state>', 'Filter by state (open, closed, all)', 'open')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const client = await createClient();
        const state = options.state === 'open' ? 'opened' : options.state;
        const issues = await client.listIssues({
          labels: options.label,
          state,
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
        handleError(error);
      }
    });

  /**
   * create-issue command
   */
  github
    .command('create-issue')
    .description('Create a new GitHub issue')
    .argument('<title>', 'Issue title')
    .option('--description <text>', 'Issue description')
    .option('--label <labels>', 'Comma-separated labels')
    .action(async (title: string, options) => {
      try {
        const client = await createClient();
        const issueNumber = await client.createIssue({
          title,
          description: options.description,
          labels: options.label ? parseLabels(options.label) : [],
        });
        console.log(chalk.green(`✓ Created issue #${issueNumber}: ${title}`));
      } catch (error) {
        handleError(error);
      }
    });

  /**
   * add-comment command
   */
  github
    .command('add-comment')
    .description('Add comment to issue')
    .argument('<number>', 'Issue number')
    .argument('<message>', 'Comment message')
    .action(async (number: string, message: string) => {
      try {
        const client = await createClient();
        await client.addComment(parseInt(number), message);
        console.log(chalk.green(`✓ Added comment to issue #${number}`));
      } catch (error) {
        handleError(error);
      }
    });

  /**
   * update-labels command
   */
  github
    .command('update-labels')
    .description('Add and/or remove labels from an issue')
    .argument('<number>', 'Issue number')
    .option('--add <labels>', 'Comma-separated labels to add')
    .option('--remove <labels>', 'Comma-separated labels to remove')
    .action(async (number: string, options) => {
      try {
        const client = await createClient();
        const issueNum = parseInt(number);

        const labelsToAdd = options.add ? parseLabels(options.add) : [];
        const labelsToRemove = options.remove ? parseLabels(options.remove) : [];

        // Add labels in parallel
        if (labelsToAdd.length > 0) {
          await Promise.all(labelsToAdd.map(label => client.addLabel(issueNum, label)));
        }

        // Remove labels in parallel
        if (labelsToRemove.length > 0) {
          await Promise.all(labelsToRemove.map(label => client.removeLabel(issueNum, label)));
        }

        console.log(chalk.green(`✓ Updated labels on issue #${number}`));
        if (options.add) console.log(chalk.gray(`  + ${options.add}`));
        if (options.remove) console.log(chalk.gray(`  - ${options.remove}`));
      } catch (error) {
        handleError(error);
      }
    });
}

async function createClient(): Promise<GitHubClient> {
  // Get token from env or gh CLI
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    try {
      token = execSync('gh auth token', { encoding: 'utf-8' }).trim();
    } catch {
      throw new Error('GITHUB_TOKEN or GH_TOKEN environment variable is required (or authenticate gh: gh auth login)');
    }
  }

  // Get repo from env or git remote
  let repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    const detected = await detectGitHubRepo();
    if (!detected) {
      throw new Error('Could not detect GitHub repository. Set GITHUB_REPOSITORY=owner/repo or run from a GitHub repository.');
    }
    repo = detected;
  }

  return new GitHubClient({ repo, auth: token });
}
