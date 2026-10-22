import { describe, expect, it } from 'vitest';
import { isWorkItemProjectKey } from '../src/work-item-project-key.js';

describe('work item project keys', () => {
  it.each(['acme/api', 'gitlab.example/acme/api', '127.0.0.1:8080/acme/api', 'gitlab.example:65535/acme/api'])('accepts %s', key => {
    expect(isWorkItemProjectKey(key)).toBe(true);
  });
  it.each([undefined, '', ' acme/api', 'acme/api#1', 'acme//api', 'acme/../api', 'acme/api:80', 'host:0/acme/api', 'host:65536/acme/api', 'host:abc/acme/api', 'host:080/acme/api', 'https://host/acme/api'])('rejects %j', key => {
    expect(isWorkItemProjectKey(key)).toBe(false);
  });
});
