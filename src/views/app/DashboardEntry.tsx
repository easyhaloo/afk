/**
 * DashboardEntry - Entry point that connects App with data layer
 */
import React, { useCallback } from 'react';
import { AppContent } from './AppContent';
import { initRegistry } from '../dashboard/registry/init';
import { Task, Issue, Project } from '../../types/dashboard';
import { TmuxClient } from '../../lib/core/tmux/tmux';
import { useData } from '../dashboard/data/useData';

// Initialize registry
initRegistry();

export function DashboardEntry() {
  const [issueProject, setIssueProject] = React.useState<Project | null>(null);

  // Use a simple state to track current view - will be replaced by new navigation
  const [currentView, setCurrentView] = React.useState<string>('tasks');

  const {
    tasks, completedTasks, issues, projects, sessions,
    projectBranches, projectTags, projectCommits,
    issueHasMore, projectHasMore,
    loadProjectDetail,
    reloadTasks, removeSession, addTaskFromIssue, launchFromIssue, launchExistingTask,
    fetchMoreIssues, fetchMoreProjects,
    invalidateDetailCache,
  } = useData(currentView as any, issueProject);

  const handleAttachSession = useCallback(async (task: Task) => {
    const sessionName = task?.session
      || (task?.platform === 'github' ? `afk-gh-${task.iid}` : null)
      || (task?.platform === 'gitlab' ? `afk-gl-${task.iid}` : null)
      || (task?.iid ? `afk-gl-${task.iid}` : null);
    if (!sessionName) return;
    try {
      const tmux = new TmuxClient();
      await tmux.attach(sessionName);
    } catch {}
  }, []);

  return (
    <AppContent
      tasks={tasks}
      completedTasks={completedTasks}
      issues={issues}
      projects={projects}
      sessions={sessions}
      projectBranches={projectBranches}
      projectTags={projectTags}
      projectCommits={projectCommits}
      issueHasMore={issueHasMore}
      projectHasMore={projectHasMore}
      onLoadProjectDetail={loadProjectDetail}
      onReloadTasks={reloadTasks}
      onRemoveSession={removeSession}
      onAddTaskFromIssue={addTaskFromIssue}
      onLaunchFromIssue={launchFromIssue}
      onLaunchExistingTask={launchExistingTask}
      onFetchMoreIssues={fetchMoreIssues}
      onFetchMoreProjects={fetchMoreProjects}
      onInvalidateDetailCache={invalidateDetailCache}
      onAttachSession={handleAttachSession}
    />
  );
}
