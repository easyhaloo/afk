import type { View } from '../ui/core/types.js';

export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly views: View[];
  readonly config?: Record<string, unknown>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  main: string;
  views?: string[];
}
