import type { View } from '../ui/core/types';

export type PluginConfigValue = string | number | boolean | null | PluginConfigObject | PluginConfigValue[];
export interface PluginConfigObject { [key: string]: PluginConfigValue | undefined; }

export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly views: View[];
  readonly config?: PluginConfigObject;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  main: string;
  views?: string[];
}
