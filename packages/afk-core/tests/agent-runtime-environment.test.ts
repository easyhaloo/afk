import { describe, expect, it } from 'vitest';
import {
  AGENT_AUTH_CHOICES,
  AGENT_AUTHS,
  AGENT_ENDPOINT_KINDS,
  AGENT_TRANSPORT_CHOICES,
  AGENT_TRANSPORTS,
} from '../src/agent-runtime-environment.js';

describe('the agent execution environment vocabulary', () => {
  it('names the transports a run can be carried by', () => {
    expect([...AGENT_TRANSPORTS]).toEqual(['process', 'exec', 'app-server']);
  });

  it('names the ways a run can authenticate', () => {
    expect([...AGENT_AUTHS]).toEqual(['chatgpt', 'api', 'unknown']);
  });

  it('names the kinds of endpoint an agent can be reached on', () => {
    expect([...AGENT_ENDPOINT_KINDS]).toEqual(['stdio', 'unix', 'ws', 'wss']);
  });

  it('offers the transports a person can choose', () => {
    // 'auto' means AFK decides; 'process' is not a choice, because the
    // plain process is how every provider but codex runs.
    expect([...AGENT_TRANSPORT_CHOICES]).toEqual(['auto', 'exec', 'app-server']);
  });

  it('offers the ways a person can choose to authenticate', () => {
    // 'auto' means AFK decides; 'unknown' is what a run reports when it
    // could not tell, so it is not offered.
    expect([...AGENT_AUTH_CHOICES]).toEqual(['auto', 'chatgpt', 'api']);
  });
});
