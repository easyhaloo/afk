import { useState, useEffect, useCallback } from 'react';
import { LoadingPhaseRegistry } from '../registry/loading';

export interface LoadingPhase {
  key: string;
  label: string;
  icon: string;
  done: boolean;
  error?: string;
  detail?: string;  // e.g., "owner/repo", "3 tasks", "2 sessions"
  visible: boolean; // phase is currently shown (for smooth transitions)
}


export function useLoadingPhases() {
  const [phases, setPhases] = useState<LoadingPhase[]>([]);
  const [isReady, setIsReady] = useState(false);

  const markDone = useCallback((key: string) => {
    setPhases(prev => prev.map(p => p.key === key ? { ...p, done: true } : p));
  }, []);

  const markError = useCallback((key: string, error: string) => {
    setPhases(prev => prev.map(p => p.key === key ? { ...p, done: true, error } : p));
  }, []);

  const setDetail = useCallback((key: string, detail: string) => {
    setPhases(prev => prev.map(p => p.key === key ? { ...p, detail } : p));
  }, []);

  const markVisible = useCallback((key: string) => {
    setPhases(prev => prev.map(p => p.key === key ? { ...p, visible: true } : p));
  }, []);

  useEffect(() => {
    const registry = LoadingPhaseRegistry.getInstance();
    const descriptors = registry.getAll();

    // Initialize phases (all invisible initially except first)
    setPhases(descriptors.map((d, i) => ({
      key: d.key,
      label: d.label,
      icon: d.icon || '●',
      done: false,
      visible: i === 0, // only first phase visible initially
    })));

    // Fetch all phases sequentially with minimum display time
    (async () => {
      for (let i = 0; i < descriptors.length; i++) {
        const d = descriptors[i];
        // Mark this phase as visible
        markVisible(d.key);

        try {
          const result = await d.fetch(setDetail);
          if (result) setDetail(d.key, result);
          markDone(d.key);
        } catch (err) {
          markError(d.key, String(err));
        }

        // Pre-display next phase (make it visible but not done yet)
        if (i + 1 < descriptors.length) {
          setPhases(prev => prev.map((p, idx) =>
            idx === i + 1 ? { ...p, visible: true } : p
          ));
        }
      }
      // Brief pause after last phase before signaling ready
      await new Promise(resolve => setTimeout(resolve, 300));
      setIsReady(true);
    })();
  }, [markDone, markError, setDetail, markVisible]);

  return { phases, isReady };
}
