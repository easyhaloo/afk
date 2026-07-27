import { Gitlab } from '@gitbeaker/node';

export interface GitLabConfig {
  url: string;
  token: string;
  projectId: string | number;
}

export interface Issue {
  iid: number;
  title: string;
  description: string;
  labels: string[];
  state: string;
  web_url: string;
}

export interface AC {
  text: string;
  items: string[];
}

export { Gitlab };
