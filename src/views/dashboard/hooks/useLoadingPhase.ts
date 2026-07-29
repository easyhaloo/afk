import { useState, useEffect, useCallback, useRef } from 'react';
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

const MIN_PHASE_DURATION = 400; // minimum ms each phase stays visible

export function useLoadingPhases() {
  const [phases, setPhases] = useState<LoadingPhase[]>([]);
  const [isReady, setIsReady] = useState(false);
  const phaseStartTimeRef = useRef<number>(0);

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
        const startTime = Date.now();

        // Mark this phase as visible
        markVisible(d.key);

        try {
          const result = await d.fetch(setDetail);
          if (result) setDetail(d.key, result);
          markDone(d.key);
        } catch (err) {
          markError(d.key, String(err));
        }

        // Ensure minimum phase duration for smooth visual rhythm
        const elapsed = Date.now() - startTime;
        const remaining = MIN_PHASE_DURATION - elapsed;
        if (remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, remaining));
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
