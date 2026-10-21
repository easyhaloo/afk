import type { AgentExecutionMode } from '@afk/core';
import type { BacklogExecutionMode } from '@afk/application';

/** Compact visual vocabulary shared by every dashboard view. */
const GITHUB_ICON = 'GH';
const GITLAB_ICON = 'GL';

export function getStatusIcon(status: string): string {
  switch (status) {
    case 'ready': return '○';
    case 'in_progress': return '▶';
    case 'verification': return '◌';
    case 'merge_ready': return '⇥';
    case 'rework': return '↺';
    case 'blocked': return '!';
    case 'done': return '✓';
    case 'active': return '●';
    case 'stale': return '!';
    case 'error': return '!';
    case 'project': return '◆';
    case 'project_github': return GITHUB_ICON;
    case 'project_gitlab': return GITLAB_ICON;
    default: return '•';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'blocked':
    case 'stale': return 'red';
    case 'error': return 'red';
    case 'in_progress':
    case 'active':
    case 'rework': return 'yellow';
    case 'verification': return 'magenta';
    case 'merge_ready': return 'blue';
    case 'done': return 'green';
    case 'ready': return 'cyan';
    case 'project': return 'gray';
    case 'project_github': return 'white';
    case 'project_gitlab': return 'magenta';
    default: return 'white';
  }
}
/**
 * The execution mode a work item carries and the execution mode an agent
 * run uses are two different things, and they used to share one function.
 * A mode added to either vocabulary then had a glyph nobody wrote, and the
 * two vocabularies answered "which mode is this" in one place and two.
 *
 * Each mapping below is exhaustive over its own vocabulary, so a mode the
 * domain gains stops this package from building rather than rendering as
 * nothing.
 */

/** The glyph for the execution mode a work item carries. */
export function getBacklogExecutionModeIcon(mode: BacklogExecutionMode): string {
  switch (mode) {
    case 'afk': return '⚙';
    case 'hitl': return '◇';
  }
}

/** The colour for the execution mode a work item carries. */
export function getBacklogExecutionModeColor(mode: BacklogExecutionMode): string {
  switch (mode) {
    case 'afk': return 'cyan';
    case 'hitl': return 'yellow';
  }
}

/** The glyph for the mode an agent run executes in. */
export function getAgentExecutionModeIcon(mode: AgentExecutionMode): string {
  switch (mode) {
    case 'batch': return '⚙';
    case 'interactive': return '◇';
  }
}

/** The colour for the mode an agent run executes in. */
export function getAgentExecutionModeColor(mode: AgentExecutionMode): string {
  switch (mode) {
    case 'batch': return 'cyan';
    case 'interactive': return 'yellow';
  }
}
