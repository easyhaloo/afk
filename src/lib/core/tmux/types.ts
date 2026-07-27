import { Signal } from '../../schemas.js';

export interface TmuxSession {
  name: string;
  window: string;
  dir: string;
  status?: string;
  created?: string;
}

export interface TmuxCaptureOptions {
  lines?: number;
  history?: number;
}

export { Signal };
