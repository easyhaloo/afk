import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkflowGraphGenerateRequest, WorkflowGraphGenerateResult, WorkflowGraphStatus } from '../../shared/ipc-contract';

const run = promisify(execFile);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateRequest(request: WorkflowGraphGenerateRequest): void {
  if (!request.workspace || path.isAbsolute(request.workspace) === false) throw new Error('workspace must be an absolute path');
  if (!idPattern.test(request.templateId)) throw new Error('templateId must be kebab-case');
  if (request.format && request.format !== 'json' && request.format !== 'archify-json') throw new Error('unsupported graph format');
}

export class WorkflowGraphService {
  async status(workspace: string, templateId: string): Promise<WorkflowGraphStatus> {
    if (!path.isAbsolute(workspace) || !idPattern.test(templateId)) throw new Error('invalid graph status request');
    const root = path.join(workspace, '.afk', 'cache', 'archify', 'workflow', templateId);
    const candidates = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const trusted = candidates.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!trusted) return { state: 'missing', templateId, diagnostics: [] };
    const graphPath = path.join(root, trusted.name, 'graph.json');
    const receiptPath = path.join(root, trusted.name, 'receipt.json');
    try {
      const [graph, receipt] = await Promise.all([fs.readFile(graphPath, 'utf8'), fs.readFile(receiptPath, 'utf8')]);
      const parsedReceipt = JSON.parse(receipt) as { inputHash?: string };
      return { state: 'trusted', templateId, inputHash: parsedReceipt.inputHash, trustedInputHash: parsedReceipt.inputHash, graph: JSON.parse(graph), diagnostics: [] };
    } catch {
      return { state: 'rejected', templateId, diagnostics: [{ severity: 'error', code: 'cache-invalid', message: 'Trusted graph cache is unreadable' }] };
    }
  }

  async generate(request: WorkflowGraphGenerateRequest): Promise<WorkflowGraphGenerateResult> {
    validateRequest(request);
    const format = request.format ?? 'json';
    const localCli = path.resolve(request.workspace, 'node_modules', '.bin', 'afk');
    const cli = existsSync(localCli) ? localCli : (process.env.AFK_CLI ?? 'afk');
    try {
      const args = ['graph', 'workflow', request.templateId, '--project', request.workspace, '--format', format];
      const { stdout } = await run(cli, args, { cwd: request.workspace, timeout: 30_000, maxBuffer: 8_000_000 });
      const payload = JSON.parse(String(stdout)) as { cache?: { directory?: string } };
      const status = await this.status(request.workspace, request.templateId);
      return { status, outputPath: payload.cache?.directory };
    } catch (error) {
      const previous = await this.status(request.workspace, request.templateId);
      return {
        status: {
          ...previous,
          state: 'rejected',
          diagnostics: [...previous.diagnostics, { severity: 'error', code: 'generation-failed', message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  }
}
