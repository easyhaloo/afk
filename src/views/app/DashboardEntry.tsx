import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box } from 'ink';
import { AppContent } from './AppContent.js';
import { initLoadingPhases, initRegistry } from '../board/registry/init.js';
import type { Task } from '../../types/board.js';
import type { TuiManagementProviderBundle } from '../board/data/backlog-adapter.js';
import type { View } from '../board/types.js';
import { StateProvider } from './state/StateContext.js';
import { createManagementProviders } from '@afk/infrastructure';
import { useData } from '../board/data/useData.js';
import { useLoadingPhases } from '../board/hooks/useLoadingPhase.js';
import { SplashScreen } from '../board/components/SplashScreen.js';
import { loadTuiViews } from '../plugins/loader.js';
import type { LoadedTuiView } from '../plugins/types.js';
import type { BoardRuntimePorts } from './runtime-ports.js';

initRegistry();

interface Props {
  /** What the board asks of the runtime. */
  ports: BoardRuntimePorts;
}

/** Compose the read-only dashboard with runtime session data. */
export function DashboardEntry({ ports }: Props) {
  // The splash screen reads the loading phases, and it reads them from an
  // effect. An effect here would be registered after that one and would run
  // after it, so the registry would still be empty when the splash looks at
  // it. Registering during the render phase puts the phases in place before
  // any effect runs; the registry's own guard makes a repeat call a no-op.
  useMemo(() => {
    initLoadingPhases(ports);
  }, [ports]);

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

  const data = useData(currentView, management, ports.taskRuntime);

  const attachSession = useCallback(async (task: Task) => {
    if (task.executionMode !== 'interactive' || !task.session) return;
    try {
      await ports.tmux.attach(task.session);
    } catch {
      // The app stays read-only even when a session is unavailable.
    }
  }, [ports.tmux]);

  const openTaskDiagnostics = useCallback(async (task: Task) => {
    if (!task.diagnosticPath) return;
    try {
      await ports.browser.open(task.diagnosticPath);
    } catch {
      // Diagnostics are supplementary and failure to open must not mutate runtime state.
    }
  }, [ports.browser]);

  if (!showApp) return <SplashScreen phases={phases} onComplete={() => setShowApp(true)} />;

  return (
    <Box flexDirection="column">
      <StateProvider allowedViews={new Set(pluginViews.map(view => view.id))}>
        <AppContent
          ports={ports}
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
