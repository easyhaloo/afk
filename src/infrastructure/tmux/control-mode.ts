import { spawn } from 'child_process';

export interface ControlModeOptions {
  session: string;
  pauseAfter?: number;  // flow control: pause after N seconds
}

type OutputCallback = (pane: string, text: string) => void;
type NotificationCallback = (line: string) => void;
type ExitCallback = () => void;

interface PendingCommand {
  id: number;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  buffers: string[];
}

const enum ParserState {
  Normal,
  InBlock,
}

/**
 * tmux Control Mode connection.
 *
 * Spawns `tmux -CC attach-session -t <session>` and maintains a persistent
 * bidirectional channel over stdin/stdout.
 *
 * Protocol:
 *   - Send commands on stdin
 *   - Sync responses: %begin <t> <id> 1 ... %end <t> <id> 1
 *   - Async notifications: %output <pane> <text>, %exit, etc.
 */
export class ControlModeConnection {
  private proc: ReturnType<typeof spawn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stdin!: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stdout!: any;
  private lineBuffer: string = '';

  private state: ParserState = ParserState.Normal;
  private currentBlockId: number = -1;
  private currentBlockBuffers: string[] = [];
  private nextCmdId: number = 1;

  private pendingCommands = new Map<number, PendingCommand>();
  private outputCallbacks: OutputCallback[] = [];
  private notificationCallbacks: NotificationCallback[] = [];
  private exitCallbacks: ExitCallback[] = [];

  private exited = false;

  constructor(options: ControlModeOptions) {
    const { session, pauseAfter } = options;

    this.proc = spawn('tmux', [
      '-CC',
      'attach-session',
      '-t', session,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.stdin = this.proc.stdin!;
    // stdout is Readable but we use 'data' event which works on Readable
    (this.stdout as any) = this.proc.stdout!;

    if (pauseAfter !== undefined && pauseAfter > 0) {
      // Enable flow control after spawn
      setTimeout(() => {
        this.sendRawCommand(`refresh-client -f pause-after=${pauseAfter}`);
      }, 500);
    }

    this.stdout.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      this.flushLines();
    });

    this.proc.on('close', (code) => {
      this.exited = true;
      this.flushPending(new Error(`Control mode process exited with code ${code}`));
      this.exitCallbacks.forEach(cb => cb());
    });

    this.proc.on('error', (err) => {
      this.flushPending(new Error(`Control mode error: ${err.message}`));
    });
  }

  /**
   * Send a command and wait for its %end response.
   */
  sendCommand(cmd: string): Promise<string> {
    if (this.exited) return Promise.reject(new Error('Connection closed'));

    return new Promise((resolve, reject) => {
      const id = this.nextCmdId++;
      const pending: PendingCommand = { id, resolve, reject, buffers: [] };
      this.pendingCommands.set(id, pending);

      this.sendRawCommand(cmd);

      // Timeout: 30s default
      const timeout = setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error(`Command ${id} timed out: ${cmd}`));
        }
      }, 30000);
      pending.resolve = (v) => { clearTimeout(timeout); resolve(v); };
      pending.reject = (e) => { clearTimeout(timeout); reject(e); };
    });
  }

  /**
   * Send a command without waiting for response (fire-and-forget).
   */
  sendRawCommand(cmd: string): void {
    this.stdin.write(cmd + '\n');
  }

  /**
   * Subscribe to pane output notifications.
   */
  onOutput(callback: OutputCallback): void {
    this.outputCallbacks.push(callback);
  }

  /**
   * Unsubscribe from pane output notifications.
   */
  offOutput(callback: OutputCallback): void {
    this.outputCallbacks = this.outputCallbacks.filter(cb => cb !== callback);
  }

  /**
   * Subscribe to all % notifications (excluding %output).
   */
  onNotification(callback: NotificationCallback): void {
    this.notificationCallbacks.push(callback);
  }

  /**
   * Subscribe to session exit.
   */
  onExit(callback: ExitCallback): void {
    this.exitCallbacks.push(callback);
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.exited) return;
    this.exited = true;
    this.sendRawCommand('detach');
    setTimeout(() => {
      this.proc.kill();
      this.flushPending(new Error('Connection closed'));
    }, 500);
  }

  private flushLines(): void {
    const lines = this.lineBuffer.split('\n');
    // Keep the last partial line in buffer
    this.lineBuffer = lines.pop() || '';

    for (const raw of lines) {
      const line = raw.trimEnd(); // remove trailing \r
      if (!line) continue;
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // %output <pane> <text> — async notification, not part of a block
    if (line.startsWith('%output ')) {
      const spaceIdx = '%output '.length;
      const nextSpace = line.indexOf(' ', spaceIdx);
      if (nextSpace === -1) return;
      const pane = line.slice(spaceIdx, nextSpace);
      const text = line.slice(nextSpace + 1);
      this.outputCallbacks.forEach(cb => cb(pane, text));
      return;
    }

    // %pause %pane and %continue %pane — flow control, ignore
    if (line.startsWith('%pause ') || line.startsWith('%continue ')) {
      return;
    }

    // %extended-output %pane <ms>: ... — flow-controlled output
    if (line.startsWith('%extended-output ')) {
      // Extract pane and text after the first two space-separated fields
      const parts = line.split(' ');
      if (parts.length >= 4) {
        const pane = parts[1];
        const text = parts.slice(3).join(' ');
        this.outputCallbacks.forEach(cb => cb(pane, text));
      }
      return;
    }

    // %begin <time> <id> <flags> — start of synchronous response block
    if (line.startsWith('%begin ')) {
      const parts = line.split(' ');
      if (parts.length >= 4) {
        this.state = ParserState.InBlock;
        this.currentBlockId = parseInt(parts[2], 10);
        this.currentBlockBuffers = [];
      }
      return;
    }

    // %end <time> <id> <flags> — end of synchronous response block
    if (line.startsWith('%end ')) {
      const parts = line.split(' ');
      if (parts.length >= 4) {
        const id = parseInt(parts[2], 10);
        const pending = this.pendingCommands.get(id);
        if (pending) {
          this.pendingCommands.delete(id);
          pending.resolve(pending.buffers.join(''));
        }
        this.state = ParserState.Normal;
        this.currentBlockId = -1;
        this.currentBlockBuffers = [];
      }
      return;
    }

    // %error <time> <id> <flags> ... — command failed
    if (line.startsWith('%error ')) {
      const parts = line.split(' ');
      if (parts.length >= 4) {
        const id = parseInt(parts[2], 10);
        const pending = this.pendingCommands.get(id);
        if (pending) {
          this.pendingCommands.delete(id);
          pending.reject(new Error('tmux command failed: ' + line));
        }
        this.state = ParserState.Normal;
      }
      return;
    }

    // %exit — session detached
    if (line === '%exit') {
      this.exited = true;
      this.exitCallbacks.forEach(cb => cb());
      return;
    }

    // All other % lines are notifications (window-add, session-changed, etc.)
    if (line.startsWith('%')) {
      this.notificationCallbacks.forEach(cb => cb(line));
      return;
    }

    // Regular output line — accumulate into current block buffer
    if (this.state === ParserState.InBlock) {
      this.currentBlockBuffers.push(line);
    }
  }

  private flushPending(err: Error): void {
    for (const [id, pending] of this.pendingCommands) {
      pending.reject(err);
    }
    this.pendingCommands.clear();
  }
}
