import { z } from 'zod';
import type { NotificationMessage, NotificationProvider, NotificationReceipt, ProviderDiagnostic, ProviderHealth, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort, requestHttp, type FetchTransport } from './dependencies.js';
import { GoogleOAuthCredentialProvider, GoogleOAuthError } from './google-oauth.js';
import { systemProxyFetch } from './system-proxy-fetch.js';

export interface GmailNotificationOptions {
  readonly credentials?: Pick<GoogleOAuthCredentialProvider, 'resolveAccount'> & Partial<Pick<GoogleOAuthCredentialProvider, 'health'>>;
  readonly to?: string;
  readonly channel?: string;
  readonly fetch?: FetchTransport;
}

function email(value: string): string {
  if (!z.string().email().safeParse(value).success || !/^[\x21-\x7e]+$/.test(value)) throw new Error('Invalid Gmail address');
  return value;
}

function subjectHeader(title: string): string {
  if (/[\r\n\0]/.test(title)) throw new Error('Invalid Gmail subject');
  const words: string[] = [];
  let chunk = '';
  for (const character of title || '(no subject)') {
    if (Buffer.byteLength(chunk + character) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

export class GmailNotificationProvider implements NotificationProvider {
  readonly id = 'notification.gmail';
  readonly capabilities = { 'direct-message': true, 'channel-post': false, mention: false } as const;
  private readonly credentials: NonNullable<GmailNotificationOptions['credentials']>;

  constructor(private readonly options: GmailNotificationOptions = {}) {
    if (options.to !== undefined) email(options.to);
    this.credentials = options.credentials ?? new GoogleOAuthCredentialProvider();
  }

  async health(options?: ProviderOperationOptions): Promise<ProviderHealth> {
    checkAbort(options);
    const boundary = 'Live Gmail API access and sending permission have not been validated; no message was sent';
    try {
      if (!this.credentials.health) return { status: 'degraded', message: `Credential metadata probe is unavailable; Google account readiness is unknown. ${boundary}` };
      const health = await this.credentials.health(options);
      checkAbort(options);
      const readiness = health.status === 'ok' ? 'Local Google credentials are ready'
        : health.status === 'unavailable' ? 'Google credentials are unavailable; run plugin doctor --plugin credential.google-oauth for passive details. If no account is saved, run plugin auth login google --client <desktop-client.json>'
          : 'Google credential metadata needs attention; an expired access token may be refreshable. Run plugin doctor --plugin credential.google-oauth for passive details';
      return { status: health.status, message: `${readiness}. ${boundary}` };
    } catch {
      checkAbort(options);
      return { status: 'degraded', message: `Could not read Google credential metadata; run plugin doctor --plugin credential.google-oauth for passive details. ${boundary}` };
    }
  }

  async doctor(options?: ProviderOperationOptions): Promise<readonly ProviderDiagnostic[]> {
    const health = await this.health(options);
    return [
      { check: 'google-credentials', ok: health.status === 'ok', detail: health.message },
      { check: 'passive-boundary', ok: true, detail: 'Live Gmail API access and sending permission have not been validated; passive diagnostics do not send messages' },
    ];
  }

  async notify(message: NotificationMessage, options?: ProviderOperationOptions): Promise<NotificationReceipt> {
    const channel = message.channel ?? this.options.channel ?? 'gmail';
    try {
      checkAbort(options);
      const subject = subjectHeader(message.title);
      const account = await this.credentials.resolveAccount(options);
      const from = email(account.email);
      const to = email(this.options.to ?? from);
      const encodedBody = Buffer.from(message.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
      const mime = [
        `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encodedBody, '',
      ].join('\r\n');
      const response = await requestHttp(this.options.fetch ?? systemProxyFetch, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { authorization: `Bearer ${account.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
      }, options);
      const result = z.object({ id: z.string().min(1) }).safeParse(await response.json());
      if (!result.success) throw new Error('Gmail did not confirm message acceptance');
      return { delivered: true, channel };
    } catch (error) {
      const failures: Readonly<Record<string, string>> = {
        'Provider HTTP transport failed': 'Cannot reach Gmail; check the network and HTTP or HTTPS proxy settings',
        'Provider HTTP request timed out': 'Cannot reach Gmail; check the network and HTTP or HTTPS proxy settings',
        'Provider HTTP request failed (401)': 'Google sign-in expired or was revoked; sign in again',
        'Provider HTTP request failed (403)': 'Gmail API access was denied; check Gmail API enablement and the granted sending permission',
        'Provider HTTP request failed (429)': 'Gmail rate limit reached; retry later',
      };
      const diagnostic = error instanceof GoogleOAuthError ? `Google authentication failed (${error.code}): ${error.message}`
        : error instanceof Error && Object.hasOwn(failures, error.message) ? failures[error.message]
          : 'Gmail could not accept the notification; check Google sign-in, API access and recipient settings';
      return { delivered: false, channel, error: diagnostic };
    }
  }
}
