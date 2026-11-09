import { platform } from 'node:os';
import type { ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import { checkAbort, executeCommand, type CommandExecutor } from './dependencies.js';

const macKeychainScript = `
ObjC.import('Foundation');
ObjC.import('Security');
function run(arguments) {
  var query = $.NSMutableDictionary.alloc.init;
  query.setObjectForKey($('genp'), $('class'));
  query.setObjectForKey($(arguments[1]), $('svce'));
  query.setObjectForKey($(arguments[2]), $('acct'));
  var status;
  if (arguments[0] === 'write') {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var attributes = $.NSMutableDictionary.alloc.init;
    attributes.setObjectForKey(data, $('v_Data'));
    status = $.SecItemUpdate(query, attributes);
    if (status === -25300) {
      query.setObjectForKey(data, $('v_Data'));
      status = $.SecItemAdd(query, null);
    }
  } else if (arguments[0] === 'read') {
    query.setObjectForKey($.NSNumber.numberWithBool(true), $('r_Data'));
    var found = Ref();
    status = $.SecItemCopyMatching(query, found);
    if (status === -25300) return JSON.stringify({ missing: true });
    if (status === 0) return JSON.stringify({ value: ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(found[0]), $.NSUTF8StringEncoding)) });
  } else {
    status = $.SecItemDelete(query);
    if (status === -25300) return JSON.stringify({ missing: true });
  }
  if (status !== 0) throw new Error('Keychain operation failed');
  return JSON.stringify({ ok: true });
}`;

export interface OAuthSecretStore {
  read(options?: ProviderOperationOptions): Promise<string | undefined>;
  write(value: string, options?: ProviderOperationOptions): Promise<void>;
  remove(options?: ProviderOperationOptions): Promise<void>;
}

export class OAuthKeychainStore implements OAuthSecretStore {
  private readonly service = 'capability.google-oauth';
  private readonly account = 'default';

  constructor(private readonly execute: CommandExecutor = executeCommand, private readonly os = platform()) {}

  private supported(): void {
    if (this.os !== 'darwin' && this.os !== 'linux') throw new Error('Google OAuth requires macOS Keychain or Linux Secret Service');
  }

  private async mac(action: 'read' | 'write' | 'remove', input?: string, options?: ProviderOperationOptions): Promise<{ missing?: boolean; value?: string }> {
    const result = await this.execute({
      command: 'osascript', args: ['-l', 'JavaScript', '-e', macKeychainScript, action, this.service, this.account],
      input, signal: options?.signal,
    });
    return JSON.parse(result.stdout) as { missing?: boolean; value?: string };
  }

  async read(options?: ProviderOperationOptions): Promise<string | undefined> {
    this.supported();
    checkAbort(options);
    try {
      let encoded: string;
      if (this.os === 'darwin') {
        const result = await this.mac('read', undefined, options);
        if (result.missing === true) return undefined;
        encoded = result.value ?? '';
      } else {
        const result = await this.execute({ command: 'secret-tool', args: ['lookup', 'service', this.service, 'account', this.account], signal: options?.signal });
        encoded = result.stdout.trim();
      }
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid keychain record');
      return Buffer.from(encoded, 'base64url').toString('utf8');
    } catch (error) {
      checkAbort(options);
      if (this.os === 'linux' && error instanceof Error && error.message === 'Provider command failed (1)') return undefined;
      throw new Error('OAuth keychain is unavailable; unlock the system keychain and retry');
    }
  }

  async write(value: string, options?: ProviderOperationOptions): Promise<void> {
    this.supported();
    checkAbort(options);
    const encoded = Buffer.from(value).toString('base64url');
    try {
      if (this.os === 'darwin') await this.mac('write', encoded, options);
      else await this.execute({
        command: 'secret-tool', args: ['store', '--label=Google OAuth', 'service', this.service, 'account', this.account],
        input: encoded, signal: options?.signal,
      });
      if (await this.read(options) !== value) throw new Error('Keychain write was not persisted');
    } catch {
      checkAbort(options);
      throw new Error('OAuth keychain could not save the account; unlock the system keychain and retry');
    }
  }

  async remove(options?: ProviderOperationOptions): Promise<void> {
    this.supported();
    if (await this.read(options) === undefined) return;
    try {
      if (this.os === 'darwin') await this.mac('remove', undefined, options);
      else await this.execute({ command: 'secret-tool', args: ['clear', 'service', this.service, 'account', this.account], signal: options?.signal });
    } catch {
      checkAbort(options);
      throw new Error('OAuth keychain could not remove the account');
    }
  }
}
