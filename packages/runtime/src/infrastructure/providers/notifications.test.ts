import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationMessage } from '../../plugin-sdk/capabilities.js';
import {
  DesktopNotificationProvider,
  EmailNotificationProvider,
  FeishuNotificationProvider,
  SlackNotificationProvider,
  desktopNotificationCommand,
} from './notifications.js';
import type { CommandExecutor, CommandRequest, FetchTransport } from './dependencies.js';

const WEBHOOK = 'https://hooks.example.test/secret-token-abc';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); })); });
afterEach(() => { vi.unstubAllGlobals(); });

const message: NotificationMessage = {
  title: 'Build failed',
  body: 'Unit tests are red on main',
  urgency: 'high',
};

interface FakeResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

/** Builds an injectable fetch transport that records every call. */
function fakeFetch(response: FakeResponse) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const transport = (async (url: unknown, init: unknown) => {
    calls.push({ url: url as URL, init: init as RequestInit });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? ''),
    } as unknown as Response;
  }) as unknown as FetchTransport;
  return { transport, calls };
}

/** Builds an injectable command executor that records every request. */
function fakeExecutor() {
  const calls: CommandRequest[] = [];
  const executor: CommandExecutor = async request => {
    calls.push(request);
    return { stdout: '', stderr: '' };
  };
  return { executor, calls };
}

describe('FeishuNotificationProvider', () => {
  it('posts a Feishu text message and reports delivery on code 0', async () => {
    const { transport, calls } = fakeFetch({ json: { code: 0, msg: 'success' } });
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK, fetch: transport });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(true);
    expect(receipt.channel).toBe('feishu');
    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe(WEBHOOK);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toContain('Build failed');
    expect(body.content.text).toContain('Unit tests are red on main');
  });

  it('treats a non-zero Feishu business code as a failure', async () => {
    const { transport } = fakeFetch({ json: { code: 19021, msg: 'sign error' } });
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK, fetch: transport });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toMatch(/code 19021/);
  });

  it('does not leak the webhook URL when default fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`failed ${WEBHOOK}`); }));
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toBeTruthy();
    expect(receipt.error).not.toContain(WEBHOOK);
    expect(receipt.error).not.toContain('secret-token-abc');
  });

  it('uses global fetch only at delivery time', async () => {
    const fetch = vi.fn(async () => new Response('{"code":0}'));
    vi.stubGlobal('fetch', fetch);
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK });
    expect(fetch).not.toHaveBeenCalled();
    expect((await provider.notify(message)).delivered).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([null, [], {}, { code: '0' }])('rejects malformed delivery acknowledgement %j', async payload => {
    const { transport } = fakeFetch({ json: payload });
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK, fetch: transport });
    expect((await provider.notify(message)).delivered).toBe(false);
  });

  it('surfaces transport-level HTTP failures without leaking the URL', async () => {
    const { transport } = fakeFetch({ status: 500, json: { code: 0 } });
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK, fetch: transport });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toMatch(/500/);
    expect(receipt.error).not.toContain(WEBHOOK);
  });

  it('respects an already-aborted signal', async () => {
    const { transport, calls } = fakeFetch({ json: { code: 0 } });
    const provider = new FeishuNotificationProvider({ webhook: WEBHOOK, fetch: transport });
    const controller = new AbortController();
    controller.abort();

    const receipt = await provider.notify(message, { signal: controller.signal });

    expect(receipt.delivered).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('SlackNotificationProvider', () => {
  it('posts a Slack message and reports delivery when the body is "ok"', async () => {
    const { transport, calls } = fakeFetch({ text: 'ok' });
    const provider = new SlackNotificationProvider({ webhook: WEBHOOK, fetch: transport });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(true);
    expect(receipt.channel).toBe('slack');
    expect(JSON.parse(calls[0].init.body as string).text).toContain('Build failed');
  });

  it('rejects a 2xx response whose body is not "ok"', async () => {
    const { transport } = fakeFetch({ status: 200, text: 'invalid_payload' });
    const provider = new SlackNotificationProvider({ webhook: WEBHOOK, fetch: transport });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toMatch(/did not accept/i);
  });

  it('does not leak the webhook URL when default fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`failed ${WEBHOOK}`); }));
    const provider = new SlackNotificationProvider({ webhook: WEBHOOK });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).not.toContain(WEBHOOK);
    expect(receipt.error).not.toContain('secret-token-abc');
  });

  it('uses default fetch without doing IO in the constructor', async () => {
    const fetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetch);
    const provider = new SlackNotificationProvider({ webhook: WEBHOOK });
    expect(fetch).not.toHaveBeenCalled();
    expect((await provider.notify(message)).delivered).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('EmailNotificationProvider', () => {
  it('pipes the composed message through stdin and keeps it out of argv', async () => {
    const { executor, calls } = fakeExecutor();
    const provider = new EmailNotificationProvider({ from: 'ci@example.test', to: 'oncall@example.test', executor });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(true);
    expect(receipt.channel).toBe('email');
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request.command).toBe('/usr/sbin/sendmail');
    expect(request.args).toEqual(['-t', '-oi', '-f', 'ci@example.test']);
    // The body travels through stdin, never as an argument.
    expect(request.input).toContain('Subject: Build failed');
    expect(request.input).toContain('Unit tests are red on main');
    expect(request.input).toContain('X-Urgency: high');
    expect(request.args.every(argument => !argument.includes('Unit tests are red on main'))).toBe(true);
  });

  it('rejects header injection via the subject', async () => {
    const { executor, calls } = fakeExecutor();
    const provider = new EmailNotificationProvider({ from: 'ci@example.test', to: 'oncall@example.test', executor });

    const receipt = await provider.notify({ ...message, title: 'hi\r\nBcc: attacker@example.test' });

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toMatch(/Subject/);
    expect(calls).toHaveLength(0);
  });

  it('rejects header injection via the sender address', async () => {
    const { executor, calls } = fakeExecutor();
    const provider = new EmailNotificationProvider({ from: 'ci@example.test\r\nBcc: x', to: 'oncall@example.test', executor });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports failures from the executor without crashing', async () => {
    const executor: CommandExecutor = async () => {
      throw new Error('sendmail not found');
    };
    const provider = new EmailNotificationProvider({ from: 'ci@example.test', to: 'oncall@example.test', executor });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toMatch(/sendmail not found/);
  });
});

describe('DesktopNotificationProvider', () => {
  it('uses osascript with an escaped script on macOS', async () => {
    const { executor, calls } = fakeExecutor();
    const provider = new DesktopNotificationProvider({ platform: 'darwin', executor });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(true);
    expect(calls[0].command).toBe('osascript');
    expect(calls[0].args[0]).toBe('-e');
    expect(calls[0].args[1]).toContain('display notification');
    expect(calls[0].args[1]).toContain('Build failed');
    expect(calls[0].args[1]).toContain('Unit tests are red on main');
  });

  it('escapes double quotes in the macOS AppleScript', () => {
    const request = desktopNotificationCommand('darwin', { title: 'He said "hi"', body: 'back\\slash' });
    const script = request.args[1]!;
    expect(script).toContain('He said \\"hi\\"');
    expect(script).toContain('back\\\\slash');
  });

  it('uses notify-send with safe argv on Linux and maps urgency', async () => {
    const { executor, calls } = fakeExecutor();
    const provider = new DesktopNotificationProvider({ platform: 'linux', executor });

    await provider.notify(message);

    expect(calls[0].command).toBe('notify-send');
    expect(calls[0].args).toEqual(['-u', 'critical', 'Build failed', 'Unit tests are red on main']);
  });

  it('pipes the PowerShell script through stdin on Windows', async () => {
    const { executor, calls } = fakeExecutor();
    const provider = new DesktopNotificationProvider({ platform: 'win32', executor });

    const receipt = await provider.notify({ ...message, title: "it's", body: "body's" });

    expect(receipt.delivered).toBe(true);
    expect(calls[0].command).toBe('powershell');
    expect(calls[0].args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-']);
    // Script content (with escaped single quotes) goes via stdin, not argv.
    expect(calls[0].input).toContain("it''s");
    expect(calls[0].input).toContain("body''s");
    expect(calls[0].args.every(argument => !argument.includes('body'))).toBe(true);
  });

  it('reports executor failures as a failed receipt', async () => {
    const executor: CommandExecutor = vi.fn(async () => {
      throw new Error('no notifier');
    });
    const provider = new DesktopNotificationProvider({ platform: 'linux', executor });

    const receipt = await provider.notify(message);

    expect(receipt.delivered).toBe(false);
    expect(receipt.error).toMatch(/no notifier/);
  });
});
