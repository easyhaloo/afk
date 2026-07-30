/**
 * LoadingPhaseRegistry - Registry for extensible loading phases
 *
 * Each data loader registers its phases, and the hook consumes them all.
 */
import type { LoadingPhase } from '../hooks/useLoadingPhase';

export interface LoadingPhaseDescriptor {
  key: string;
  label: string;
  icon?: string;
  fetch: (setDetail: (key: string, detail: string) => void) => Promise<string | void>;
}

class LoadingPhaseRegistry {
  private static instance: LoadingPhaseRegistry;
  private phases = new Map<string, LoadingPhaseDescriptor>();

  static getInstance(): LoadingPhaseRegistry {
    if (!LoadingPhaseRegistry.instance) {
      LoadingPhaseRegistry.instance = new LoadingPhaseRegistry();
    }
    return LoadingPhaseRegistry.instance;
  }

  register(descriptor: LoadingPhaseDescriptor): void {
    if (this.phases.has(descriptor.key)) {
      throw new Error(`Loading phase "${descriptor.key}" already registered`);
    }
    this.phases.set(descriptor.key, descriptor);
  }

  getAll(): LoadingPhaseDescriptor[] {
    return Array.from(this.phases.values());
  }

  has(key: string): boolean {
    return this.phases.has(key);
  }
}

export { LoadingPhaseRegistry };
