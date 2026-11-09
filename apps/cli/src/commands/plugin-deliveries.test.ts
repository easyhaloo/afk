import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import { registerPluginCommands } from './plugin.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('inspects and replays through the authenticated listener without redirecting credentials', async () => {
  vi.stubEnv('TEST_LISTENER_TOKEN', 'synthetic-listener-token');
  const network = vi.fn(async (_url: URL, _options: RequestInit) => new Response('{"accepted":true}', { status: 202 }));
  vi.stubGlobal('fetch', network);
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const program = new Command().exitOverride();
  registerPluginCommands(program);
  await program.parseAsync(['node', 'afk', 'plugin', 'deliveries', '--token-env', 'TEST_LISTENER_TOKEN']);
  const deliveryId = 'a'.repeat(64);
  await program.parseAsync(['node', 'afk', 'plugin', 'replay', deliveryId, '--token-env', 'TEST_LISTENER_TOKEN']);
  expect(network.mock.calls.map(call => String(call[0]))).toEqual(['http://127.0.0.1:8374/deliveries?offset=0&limit=100', `http://127.0.0.1:8374/deliveries/${deliveryId}/replay`]);
  expect(network.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer synthetic-listener-token' } });
  await program.parseAsync(['node', 'afk', 'plugin', 'prune-deliveries', '--token-env', 'TEST_LISTENER_TOKEN']);
  expect(String(network.mock.calls[2][0])).toBe('http://127.0.0.1:8374/deliveries/prune');
  expect(network.mock.calls[2][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  await expect(program.parseAsync(['node', 'afk', 'plugin', 'deliveries', '--token-env', 'TEST_LISTENER_TOKEN', '--url', 'http://external.example'])).rejects.toThrow('HTTPS or loopback');
  await expect(program.parseAsync(['node', 'afk', 'plugin', 'replay', '../invalid', '--token-env', 'TEST_LISTENER_TOKEN'])).rejects.toThrow('Invalid trigger delivery ID');
  await expect(program.parseAsync(['node', 'afk', 'plugin', 'deliveries', '--token-env', 'TEST_LISTENER_TOKEN', '--url', 'http://127.0.0.1:8374', '--limit', '101'])).rejects.toThrow('pagination');
  expect(network).toHaveBeenCalledTimes(3);
  expect(output).toHaveBeenCalledTimes(3);
});
