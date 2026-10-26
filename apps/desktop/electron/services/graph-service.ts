import { workspaceDataDirectory } from '@afk/runtime/infrastructure/workspace';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { generateWorkflowGraph } from '@afk/runtime/application/visualizations/workflow-graph';
import { writeGraphCache } from '@afk/runtime/application/visualizations/graph-cache';
import type { WorkflowGraphGenerateRequest, WorkflowGraphGenerateResult, WorkflowGraphStatus } from '../../shared/ipc-contract.js';

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateRequest(request: WorkflowGraphGenerateRequest): void {
  if (!request.workspace || path.isAbsolute(request.workspace) === false) throw new Error('workspace must be an absolute path');
  if (!idPattern.test(request.templateId)) throw new Error('templateId must be kebab-case');
  if (request.format && request.format !== 'json' && request.format !== 'archify-json') throw new Error('unsupported graph format');
}

export class WorkflowGraphService {
  async status(workspace: string, templateId: string): Promise<WorkflowGraphStatus> {
    if (!path.isAbsolute(workspace) || !idPattern.test(templateId)) throw new Error('invalid graph status request');
    const root = path.join(workspaceDataDirectory(workspace), 'cache', 'archify', 'workflow', templateId);
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
    try {
      const result = await generateWorkflowGraph({ projectRoot: request.workspace, template: request.templateId });
      if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) throw new Error('workflow graph validation failed');
      const cache = await writeGraphCache(request.workspace, result, format);
      const status = await this.status(request.workspace, request.templateId);
      return { status, outputPath: cache.directory };
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
