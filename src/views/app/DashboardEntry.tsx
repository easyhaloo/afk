import React, { useCallback, useEffect, useState } from 'react';
import { Box } from 'ink';
import { AppContent } from './AppContent.js';
import { initRegistry } from '../board/registry/init.js';
import type { Task } from '../../types/board.js';
import type { TuiManagementProviderBundle } from '../board/data/backlog-adapter.js';
import type { View } from '../board/types.js';
import { StateProvider } from './state/StateContext.js';
import { TmuxClient } from '../../infrastructure/tmux/tmux.js';
import { createManagementProviders } from '../../infrastructure/provider/tracker-provider-factory.js';
import { useData } from '../board/data/useData.js';
import { useLoadingPhases } from '../board/hooks/useLoadingPhase.js';
import { SplashScreen } from '../board/components/SplashScreen.js';
import { openInBrowser } from '../../shared/browser.js';
import { loadTuiViews } from '../plugins/loader.js';
import type { LoadedTuiView } from '../plugins/types.js';

initRegistry();

/** Compose the read-only dashboard with runtime session data. */
export function DashboardEntry() {
  const { phases, isReady } = useLoadingPhases();
  const [showApp, setShowApp] = useState(process.env.AFK_SKIP_SPLASH === '1');
  const [currentView, setCurrentView] = useState<View>('tasks');
  const [management, setManagement] = useState<TuiManagementProviderBundle | null>(null);
  const [pluginViews, setPluginViews] = useState<readonly LoadedTuiView[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadTuiViews().then(views => {
      if (!cancelled) setPluginViews(views);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isReady) setShowApp(true);
  }, [isReady]);

  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    void createManagementProviders(process.env.AFK_PROJECT, process.cwd())
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
      <StateProvider allowedViews={new Set(pluginViews.map(view => view.id))}>
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
          pluginViews={pluginViews}
          cwd={process.cwd()}
          workspace={process.env.AFK_PROJECT}
        />
      </StateProvider>
    </Box>
  );
}
