import React, { useCallback, useEffect, useState } from 'react';
import { Box } from 'ink';
import { AppContent } from './AppContent';
import { initRegistry } from '../board/registry/init';
import type { Task } from '../../types/board';
import type { TuiManagementProviderBundle } from '../board/data/backlog-adapter';
import type { View } from '../board/types';
import { StateProvider } from './state/StateContext';
import { TmuxClient } from '../../infrastructure/tmux/tmux';
import { createManagementProviderBundle } from '../../application/tracker-provider-factory';
import { useData } from '../board/data/useData';
import { useLoadingPhases } from '../board/hooks/useLoadingPhase';
import { SplashScreen } from '../board/components/SplashScreen';
import { openInBrowser } from '../../cli/cli-utils';

initRegistry();

/** Compose the read-only dashboard with runtime session data. */
export function DashboardEntry() {
  const { phases, isReady } = useLoadingPhases();
  const [showApp, setShowApp] = useState(false);
  const [currentView, setCurrentView] = useState<View>('tasks');
  const [management, setManagement] = useState<TuiManagementProviderBundle | null>(null);

  useEffect(() => {
    if (isReady) setShowApp(true);
  }, [isReady]);

  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    void createManagementProviderBundle(process.env.AFK_PROJECT, process.cwd())
      .then(bundle => {
        if (!cancelled) {
          setManagement({ backlog: { list: options => bundle.backlog.list(options) } });
        }
      })
      .catch(error => console.warn('backlog provider unavailable:', error));
    return () => { cancelled = true; };
  }, [isReady]);

  const data = useData(currentView, management);

  const attachSession = useCallback(async (task: Task) => {
    if (task.executionMode !== 'interactive' || !task.session) return;
    try {
      await new TmuxClient().attach(task.session);
    } catch {
      // The app stays read-only even when a session is unavailable.
    }
  }, []);

  const openTaskDiagnostics = useCallback(async (task: Task) => {
    if (!task.diagnosticPath) return;
    try {
      await openInBrowser(task.diagnosticPath);
    } catch {
      // Diagnostics are supplementary and failure to open must not mutate runtime state.
    }
  }, []);

  if (!showApp) return <SplashScreen phases={phases} onComplete={() => setShowApp(true)} />;

  return (
    <Box flexDirection="column">
      <StateProvider>
        <AppContent
          tasks={data.tasks}
          backlogs={data.backlogs}
          projects={data.projects}
          projectBranches={data.projectBranches}
          projectTags={data.projectTags}
          projectCommits={data.projectCommits}
          projectHasMore={data.projectHasMore}
          onLoadProjectDetail={data.loadProjectDetail}
          onReloadTasks={data.reloadTasks}
          onReloadBacklogs={data.refreshBacklogs}
          onFetchMoreProjects={data.fetchMoreProjects}
          onInvalidateDetailCache={data.invalidateDetailCache}
          onAttachSession={attachSession}
          onOpenTaskDiagnostics={openTaskDiagnostics}
          onViewChange={setCurrentView}
        />
      </StateProvider>
    </Box>
  );
}
