import { useState, useEffect, useCallback } from 'react';
import { LoadingPhaseRegistry } from '../registry/loading';

export interface LoadingPhase {
  key: string;
  label: string;
  icon: string;
  done: boolean;
  error?: string;
  detail?: string;  // e.g., "owner/repo", "3 tasks", "2 sessions"
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

    // Fetch all phases sequentially (config → detect → connect → tasks → sessions → ready)
    (async () => {
      for (const d of descriptors) {
        try {
          const result = await d.fetch(setDetail);
          if (result) setDetail(d.key, result);
          markDone(d.key);
        } catch (err) {
          markError(d.key, String(err));
        }
      }
      setTimeout(() => setIsReady(true), 200);
    })();
  }, [markDone, markError, setDetail]);

  return { phases, isReady };
}
