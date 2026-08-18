import { Command } from 'commander';
import chalk from 'chalk';
import { createTracker } from '../../application/tracker-provider-factory';
import type { TrackedIssue } from '../../domain/tracker/types.js';
import { handleCommandError, warning, detail } from '../cli-utils.js';

interface BoardColumn {
  title: string;
  issues: TrackedIssue[];
}

/**
 * Group issues into board columns based on labels
 */
function groupIssuesByColumn(issues: TrackedIssue[]): Record<string, BoardColumn> {
  const columns: Record<string, BoardColumn> = {
    open: { title: 'Open', issues: [] },
    'in-progress': { title: 'In Progress', issues: [] },
    blocked: { title: 'Blocked', issues: [] },
    done: { title: 'Done', issues: [] },
  };

  for (const issue of issues) {
    if (issue.state === 'closed') {
      columns.done.issues.push(issue);
    } else if (issue.labels.some(l => l.toLowerCase().includes('in-progress') || l.toLowerCase().includes('in progress'))) {
      columns['in-progress'].issues.push(issue);
    } else if (issue.labels.some(l => l.toLowerCase().includes('blocked'))) {
      columns.blocked.issues.push(issue);
    } else {
      columns.open.issues.push(issue);
    }
  }

  return columns;
}

/**
 * Render board to console
 */
function renderBoard(columns: Record<string, BoardColumn>) {
  const columnOrder = ['open', 'in-progress', 'blocked', 'done'];
  const colWidth = 40;

  // Header
  console.log();
  for (const key of columnOrder) {
    const col = columns[key];
    process.stdout.write(chalk.bold(col.title.padEnd(colWidth)));
  }
  console.log();
  for (const key of columnOrder) {
    process.stdout.write('─'.repeat(colWidth));
  }
  console.log();

  // Find max rows
  const maxRows = Math.max(...columnOrder.map(key => columns[key].issues.length));

  // Render rows
  for (let row = 0; row < maxRows; row++) {
    for (const key of columnOrder) {
      const issue = columns[key].issues[row];
      if (issue) {
        const platform = issue.platform === 'github' ? chalk.blue('[GH]') : chalk.green('[GL]');
        const title = issue.title.length > 30 ? issue.title.slice(0, 27) + '...' : issue.title;
        const cell = `${platform} #${issue.id} ${title}`;
        process.stdout.write(cell.padEnd(colWidth).slice(0, colWidth));
      } else {
        process.stdout.write(' '.repeat(colWidth));
      }
    }
    console.log();
  }
  console.log();
}

export function registerKanbanCommands(program: Command): void {
  const kanban = program
    .command('kanban')
    .description('Display kanban board of issues (GitLab + GitHub)')
    .option('--platform <platform>', 'Filter by platform (github|gitlab)')
    .option('--label <label>', 'Filter by label')
    .action(async (options) => {
      try {
        const tracker = await createTracker();
        detail(`Platform: ${tracker.platform}`);
        detail(`Project: ${tracker.projectId}`);

        const listOptions: any = { state: 'all' };
        if (options.label) listOptions.labels = [options.label];

        const issues = await tracker.listIssues(listOptions);

        // Filter by platform if specified
        const filtered = options.platform
          ? issues.filter(i => i.platform === options.platform)
          : issues;

        if (filtered.length === 0) {
          warning('No issues found');
          return;
        }

        const columns = groupIssuesByColumn(filtered);
        renderBoard(columns);

        detail(`Total: ${filtered.length} issues`);
      } catch (error) {
        handleCommandError(error);
      }
    });
}
