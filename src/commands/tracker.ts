import { Command } from 'commander';
import chalk from 'chalk';
import { createTrackerClient } from '../lib/client-factory';
import { handleCommandError, parseCommaSeparated } from '../lib/cli-utils';

/**
 * Register unified tracker commands (platform-agnostic)
 *
 * Commands auto-detect platform (GitHub/GitLab) from git remote
 * and delegate to appropriate client implementation.
 */
export function registerTrackerCommands(program: Command): void {
  const issue = program
    .command('issue')
    .description('Issue operations (auto-detects platform)');

  /**
   * get command
   */
  issue
    .command('get')
    .description('Get issue by ID')
    .argument('<id>', 'Issue ID')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options) => {
      try {
        const client = await createTrackerClient();
        const issue = await client.getIssue(parseInt(id));

        if (options.json) {
          console.log(JSON.stringify(issue, null, 2));
        } else {
          console.log(chalk.bold(`#${issue.id}: ${issue.title}`));
          console.log(chalk.gray(`Platform: ${issue.platform}`));
          console.log(chalk.gray(`State: ${issue.state}`));
          console.log(chalk.gray(`Labels: ${issue.labels.join(', ')}`));
          console.log(chalk.gray(`URL: ${issue.url}`));
          console.log();
          console.log(chalk.dim(issue.description));
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * list command
   */
  issue
    .command('list')
    .description('List issues with filters')
    .option('-l, --label <labels...>', 'Filter by labels')
    .option('-s, --state <state>', 'Filter by state (opened, closed, all)', 'opened')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const client = await createTrackerClient();
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
      }
    });

  /**
   * create command
   */
  issue
    .command('create')
    .description('Create a new issue')
    .argument('<title>', 'Issue title')
    .option('--description <text>', 'Issue description')
    .option('--label <labels>', 'Comma-separated labels')
    .option('--json', 'Output as JSON')
    .action(async (title: string, options) => {
      try {
        const client = await createTrackerClient();
        const issueId = await client.createIssue({
          title,
          description: options.description,
          labels: options.label ? parseCommaSeparated(options.label) : [],
        });

        if (options.json) {
          console.log(JSON.stringify({ id: issueId, platform: client.platform }, null, 2));
        } else {
          console.log(chalk.green(`✓ Created issue #${issueId}: ${title}`));
        }
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * update-labels command
   */
  issue
    .command('update-labels')
    .description('Add and/or remove labels from an issue')
    .argument('<id>', 'Issue ID')
    .option('--add <labels>', 'Comma-separated labels to add')
    .option('--remove <labels>', 'Comma-separated labels to remove')
    .action(async (id: string, options) => {
      try {
        const client = await createTrackerClient();
        const issueId = parseInt(id);

        const labelsToAdd = options.add ? parseCommaSeparated(options.add) : [];
        const labelsToRemove = options.remove ? parseCommaSeparated(options.remove) : [];

        // Add labels in parallel
        if (labelsToAdd.length > 0) {
          await Promise.all(labelsToAdd.map(label => client.addLabel(issueId, label)));
        }

        // Remove labels in parallel
        if (labelsToRemove.length > 0) {
          await Promise.all(labelsToRemove.map(label => client.removeLabel(issueId, label)));
        }

        console.log(chalk.green(`✓ Updated labels on issue #${id}`));
        if (options.add) console.log(chalk.gray(`  + ${options.add}`));
        if (options.remove) console.log(chalk.gray(`  - ${options.remove}`));
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * comment command
   */
  issue
    .command('comment')
    .description('Add comment to issue')
    .argument('<id>', 'Issue ID')
    .argument('<message>', 'Comment message')
    .action(async (id: string, message: string) => {
      try {
        const client = await createTrackerClient();
        await client.addComment(parseInt(id), message);
        console.log(chalk.green(`✓ Added comment to issue #${id}`));
      } catch (error) {
        handleCommandError(error);
      }
    });

  /**
   * link command
   */
  issue
    .command('link')
    .description('Link two issues')
    .argument('<source>', 'Source issue ID')
    .argument('<target>', 'Target issue ID')
    .option('--type <type>', 'Link type (blocks, blocked_by, related_to)', 'related_to')
    .action(async (source: string, target: string, options) => {
      try {
        const client = await createTrackerClient();
        const sourceId = parseInt(source);
        const targetId = parseInt(target);
        const linkType = options.type === 'blocks' ? 'blocks' :
                        options.type === 'blocked_by' ? 'blocked_by' :
                        options.type === 'is_blocked_by' ? 'is_blocked_by' :
                        'related_to';

        await client.linkIssues(sourceId, targetId, linkType);
        console.log(chalk.green(`✓ Linked issue #${source} to #${target} (${linkType})`));
      } catch (error) {
        handleCommandError(error);
      }
    });
}
