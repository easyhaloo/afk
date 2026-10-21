import { describe, expect, it } from 'vitest';
import {
  AFK_RESOURCE_ENGINES,
  AFK_RESOURCE_KINDS,
  AFK_RESOURCE_ORIGINS,
  AFK_RESOURCE_STATUSES,
  sqlValueList,
} from './resource.js';

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

  it('writes the table its check constraints from the same lists', () => {
    // The check constraint is the database's answer to "which values may
    // this column hold". A kind the registry can register and the
    // database refuses is a resource that cannot be stored at all.
    expect(sqlValueList(AFK_RESOURCE_KINDS)).toBe("'tmux', 'container', 'isolate-service'");
    expect(sqlValueList(AFK_RESOURCE_ORIGINS)).toBe("'local-sandbox', 'container-sandbox', 'isolate'");
    expect(sqlValueList(AFK_RESOURCE_ENGINES)).toBe("'docker', 'podman'");
    expect(sqlValueList(AFK_RESOURCE_STATUSES)).toBe("'active', 'closed', 'missing', 'failed'");
  });
});
