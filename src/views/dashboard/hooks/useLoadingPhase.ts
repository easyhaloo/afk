import { useState, useEffect, useCallback } from 'react';
import { LoadingPhaseRegistry } from '../registry/loading';

export interface LoadingPhase {
  key: string;
  label: string;
  icon: string;
  done: boolean;
  error?: string;
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

  useEffect(() => {
    const registry = LoadingPhaseRegistry.getInstance();
    const descriptors = registry.getAll();

    // Initialize phases as not-done
    setPhases(descriptors.map(d => ({
      key: d.key,
      label: d.label,
      icon: d.icon || '●',
      done: false,
    })));

    // Fetch all phases in parallel
    Promise.allSettled(
      descriptors.map(async (d) => {
        await d.fetch();
        markDone(d.key);
      })
    ).then((results) => {
      // Mark any failed phases with error
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          markError(descriptors[i].key, String(result.reason));
        }
      });

      // Mark ready after all complete
      setTimeout(() => {
        setIsReady(true);
      }, 200);
    });
  }, [markDone, markError]);

  return { phases, isReady };
}
