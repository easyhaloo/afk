import { describe, expect, it } from 'vitest';
import {
  AFK_RESOURCE_ENGINES,
  AFK_RESOURCE_KINDS,
  AFK_RESOURCE_ORIGINS,
  AFK_RESOURCE_STATUSES,
} from '../src/afk-resources.js';

describe('the resource vocabulary', () => {
  it('names the kinds of environment a run can register', () => {
    expect([...AFK_RESOURCE_KINDS]).toEqual(['tmux', 'container', 'isolate-service']);
  });

  it('names where a resource came from', () => {
    expect([...AFK_RESOURCE_ORIGINS]).toEqual(['local-sandbox', 'container-sandbox', 'isolate']);
  });

  it('names the states a resource can be in', () => {
    expect([...AFK_RESOURCE_STATUSES]).toEqual(['active', 'closed', 'missing', 'failed']);
  });

  it('names the container engines a resource can run on', () => {
    expect([...AFK_RESOURCE_ENGINES]).toEqual(['docker', 'podman']);
  });
});
