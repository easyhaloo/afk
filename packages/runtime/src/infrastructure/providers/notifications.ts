/**
 * Concrete notification providers.
 *
 * Each provider turns a neutral {@link NotificationMessage} into a real,
 * vendor-specific delivery:
 *
 * - `FeishuNotificationProvider` posts a Feishu/Lark "text" message to an
 *   incoming webhook and inspects the Feishu business `code` in the response
 *   body (Feishu answers HTTP 200 even when it rejects a message).
 * - `SlackNotificationProvider` posts to a Slack incoming webhook and validates
 *   that the (2xx) response body is the literal `ok` Slack returns on success.
 * - `EmailNotificationProvider` hands the composed RFC-822 message to a
 *   `sendmail`-compatible binary through **stdin**; header values are rejected
 *   when they carry CR/LF (header injection) and neither the message body nor
 *   any secret is ever placed into a process argument.
 * - `DesktopNotificationProvider` maps the current platform onto a native
 *   notifier (`osascript` / `notify-send` / PowerShell) using safe argv or
 *   script piped through stdin.
 *
 * Invariants shared by every provider here:
 * - Constructors never perform IO; they only capture configuration.
 * - HTTP uses an injected transport or global fetch when notify is called.
 * - Failure receipts never echo the webhook URL or any secret; every error
 *   message is passed through a redactor that strips known sensitive strings.
 */
import type {
  NotificationCapability,
  NotificationMessage,
  NotificationProvider,
  NotificationReceipt,
  ProviderOperationOptions,
} from '../../plugin-sdk/capabilities.js';
import { checkAbort, executeCommand, requestHttp } from './dependencies.js';
import type { CommandExecutor, CommandRequest, FetchTransport } from './dependencies.js';

/** Flattens a neutral message into the single text body webhook providers send. */
function renderText(message: NotificationMessage): string {
  const urgency = message.urgency && message.urgency !== 'normal' ? `[${message.urgency.toUpperCase()}] ` : '';
  const title = message.title ? `${urgency}${message.title}\n` : urgency;
  return `${title}${message.body}`;
}

/**
 * Renders an error message for a receipt while stripping every secret the
 * caller declares. Keeps failures diagnosable without leaking credentials.
 */
function describeError(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  if (!message) message = 'Notification failed';
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message;
}

// --- Feishu / Lark ---

export interface FeishuNotificationOptions {
  /** Incoming webhook URL. Treated as a secret and never echoed in receipts. */
  readonly webhook: string;
  /** Optional transport; defaults to global fetch at delivery time. */
  readonly fetch?: FetchTransport;
  /** Channel label reported in receipts. */
  readonly channel?: string;
}

/**
 * Feishu/Lark custom-bot webhook notifier.
 *
 * Feishu responds HTTP 200 with a JSON body whose `code` is `0` on success and
 * non-zero when the message was rejected, so the body code is checked in
 * addition to the transport-level status handled by `requestHttp`.
 */
export class FeishuNotificationProvider implements NotificationProvider {
  readonly id = 'notification.feishu';
  readonly capabilities: Readonly<Record<NotificationCapability, boolean>> = {
    'direct-message': true,
    'channel-post': true,
    mention: false,
  };

  private readonly webhook: string;
  private readonly fetch?: FetchTransport;
  private readonly defaultChannel: string;

  constructor(options: FeishuNotificationOptions) {
    this.webhook = options.webhook;
    this.fetch = options.fetch;
    this.defaultChannel = options.channel ?? 'feishu';
  }

  async notify(message: NotificationMessage, options?: ProviderOperationOptions): Promise<NotificationReceipt> {
    const channel = message.channel ?? this.defaultChannel;
    try {
      const response = await requestHttp(
        this.fetch,
        this.webhook,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ msg_type: 'text', content: { text: renderText(message) } }),
        },
        options,
      );
      const payload = (await response.json()) as { readonly code?: unknown } | null;
      if (typeof payload?.code !== 'number' || !Number.isFinite(payload.code)) {
        return { delivered: false, channel, error: 'Feishu returned an invalid delivery response' };
      }
      if (payload.code !== 0) {
        return { delivered: false, channel, error: `Feishu rejected the message (code ${payload.code})` };
      }
      return { delivered: true, channel };
    } catch (error) {
      return { delivered: false, channel, error: describeError(error, [this.webhook]) };
    }
  }
}

// --- Slack ---

export interface SlackNotificationOptions {
  /** Slack incoming-webhook URL. Treated as a secret. */
  readonly webhook: string;
  readonly fetch?: FetchTransport;
  readonly channel?: string;
}

/**
 * Slack incoming-webhook notifier.
 *
 * Slack answers a well-formed post with HTTP 200 and the literal body `ok`;
 * anything else in the body means Slack did not accept the message, so the body
 * is validated even when the transport reports a 2xx.
 */
export class SlackNotificationProvider implements NotificationProvider {
  readonly id = 'notification.slack';
  readonly capabilities: Readonly<Record<NotificationCapability, boolean>> = {
    'direct-message': false,
    'channel-post': true,
    mention: true,
  };

  private readonly webhook: string;
  private readonly fetch?: FetchTransport;
  private readonly defaultChannel: string;

  constructor(options: SlackNotificationOptions) {
    this.webhook = options.webhook;
    this.fetch = options.fetch;
    this.defaultChannel = options.channel ?? 'slack';
  }

  async notify(message: NotificationMessage, options?: ProviderOperationOptions): Promise<NotificationReceipt> {
    const channel = message.channel ?? this.defaultChannel;
    try {
      const response = await requestHttp(
        this.fetch,
        this.webhook,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ text: renderText(message) }),
        },
        options,
      );
      const body = (await response.text()).trim().toLowerCase();
      if (body !== 'ok') {
        return { delivered: false, channel, error: 'Slack did not accept the message' };
      }
      return { delivered: true, channel };
    } catch (error) {
      return { delivered: false, channel, error: describeError(error, [this.webhook]) };
    }
  }
}

// --- Email (sendmail) ---

export interface EmailNotificationOptions {
  /** Envelope/header sender address. */
  readonly from: string;
  /** Default recipient mailbox. */
  readonly to: string;
  /** Path to a `sendmail`-compatible binary. */
  readonly sendmailPath?: string;
  /** Injectable command executor; defaults to the shared `executeCommand`. */
  readonly executor?: CommandExecutor;
  readonly channel?: string;
}

/**
 * `sendmail` notifier.
 *
 * The composed message is piped through **stdin**; process arguments carry only
 * flags and the (validated) envelope sender, never the body or any secret. Header
 * values are rejected when they contain CR or LF to prevent header injection.
 */
export class EmailNotificationProvider implements NotificationProvider {
  readonly id = 'notification.email';
  readonly capabilities: Readonly<Record<NotificationCapability, boolean>> = {
    'direct-message': true,
    'channel-post': false,
    mention: false,
  };

  private readonly from: string;
  private readonly to: string;
  private readonly sendmailPath: string;
  private readonly executor: CommandExecutor;
  private readonly defaultChannel: string;

  constructor(options: EmailNotificationOptions) {
    this.from = options.from;
    this.to = options.to;
    this.sendmailPath = options.sendmailPath ?? '/usr/sbin/sendmail';
    this.executor = options.executor ?? executeCommand;
    this.defaultChannel = options.channel ?? 'email';
  }

  async notify(message: NotificationMessage, options?: ProviderOperationOptions): Promise<NotificationReceipt> {
    const channel = message.channel ?? this.defaultChannel;
    try {
      checkAbort(options);
      const mime = this.compose(message);
      await this.executor({
        command: this.sendmailPath,
        args: ['-t', '-oi', '-f', this.from],
        input: mime,
        signal: options?.signal,
      });
      return { delivered: true, channel };
    } catch (error) {
      return { delivered: false, channel, error: describeError(error, [this.from, this.to]) };
    }
  }

  /** Builds the RFC-822 message; header values are CRLF-injection screened. */
  private compose(message: NotificationMessage): string {
    const header = (name: string, value: string): string => {
      if (/[\r\n]/.test(value)) throw new Error(`Invalid ${name} header: CR/LF is not allowed`);
      return `${name}: ${value}`;
    };
    return [
      header('From', this.from),
      header('To', this.to),
      header('Subject', message.title || '(no subject)'),
      header('X-Urgency', message.urgency ?? 'normal'),
      '',
      message.body,
    ].join('\r\n');
  }
}

// --- Desktop ---

export type DesktopPlatform = 'darwin' | 'linux' | 'win32';

export interface DesktopNotificationOptions {
  /** Platform selector; defaults to the current `process.platform`. */
  readonly platform?: DesktopPlatform;
  readonly executor?: CommandExecutor;
  readonly channel?: string;
}

/** Double-quotes a value for safe interpolation into an AppleScript string. */
function appleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Single-quotes a value for safe interpolation into a PowerShell string. */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function desktopUrgency(urgency: NotificationMessage['urgency']): string {
  if (urgency === 'high') return 'critical';
  if (urgency === 'low') return 'low';
  return 'normal';
}

/**
 * Maps a platform + message onto a concrete command request. macOS and Linux
 * use argv only; Windows pipes the PowerShell script through stdin. The message
 * text is never passed through a shell.
 */
export function desktopNotificationCommand(platform: DesktopPlatform, message: NotificationMessage): CommandRequest {
  const title = message.title;
  const body = message.body;
  switch (platform) {
    case 'darwin': {
      const script = `display notification ${appleQuote(body)} with title ${appleQuote(title)}`;
      return { command: 'osascript', args: ['-e', script] };
    }
    case 'linux':
      return { command: 'notify-send', args: ['-u', desktopUrgency(message.urgency), title, body] };
    case 'win32': {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        `[System.Windows.Forms.MessageBox]::Show(${powerShellQuote(body)}, ${powerShellQuote(title)})`,
      ].join('\n');
      return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', '-'], input: script };
    }
  }
}

function defaultDesktopPlatform(): DesktopPlatform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'win32';
  return 'linux';
}

/**
 * Native desktop notifier with an injectable command executor, so tests (and
 * alternate environments) can supply a recorder instead of spawning a process.
 */
export class DesktopNotificationProvider implements NotificationProvider {
  readonly id = 'notification.desktop';
  readonly capabilities: Readonly<Record<NotificationCapability, boolean>> = {
    'direct-message': true,
    'channel-post': false,
    mention: true,
  };

  private readonly platform: DesktopPlatform;
  private readonly executor: CommandExecutor;
  private readonly defaultChannel: string;

  constructor(options: DesktopNotificationOptions = {}) {
    this.platform = options.platform ?? defaultDesktopPlatform();
    this.executor = options.executor ?? executeCommand;
    this.defaultChannel = options.channel ?? 'desktop';
  }

  async notify(message: NotificationMessage, options?: ProviderOperationOptions): Promise<NotificationReceipt> {
    const channel = message.channel ?? this.defaultChannel;
    try {
      checkAbort(options);
      const request = desktopNotificationCommand(this.platform, message);
      await this.executor({ ...request, signal: options?.signal });
      return { delivered: true, channel };
    } catch (error) {
      return { delivered: false, channel, error: describeError(error, []) };
    }
  }
}
