/**
 * View Registry - Singleton registry for all dashboard views
 * Uses Registry Pattern for extensible view management
 */

export interface ViewDescriptor {
  name: string;
  label: string;
  icon: string;
}

export class ViewRegistry {
  private static instance: ViewRegistry;
  private views = new Map<string, ViewDescriptor>();

  static getInstance(): ViewRegistry {
    if (!ViewRegistry.instance) {
      ViewRegistry.instance = new ViewRegistry();
    }
    return ViewRegistry.instance;
  }

  register(descriptor: ViewDescriptor): void {
    if (this.views.has(descriptor.name)) {
      throw new Error(`View "${descriptor.name}" already registered`);
    }
    this.views.set(descriptor.name, descriptor);
  }

  get(name: string): ViewDescriptor | undefined {
    return this.views.get(name);
  }

  getAll(): ViewDescriptor[] {
    return Array.from(this.views.values());
  }

  has(name: string): boolean {
    return this.views.has(name);
  }
}
