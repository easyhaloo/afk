import Ajv from 'ajv';
import type { CandidateProposal } from './contracts.js';
import { canonicalLearningJson } from './requests.js';

type ToolPayload = Extract<CandidateProposal, { kind: 'tool' }>['payload'];
export type ProposalToolSchema = ToolPayload['inputSchema'];

export function compileProposalToolSchema(schema: ProposalToolSchema) {
  if (Buffer.byteLength(canonicalLearningJson(schema)) > 8192) throw new Error('Tool schema exceeds byte limit');
  const inspect = (value: unknown, depth: number): void => {
    if (depth > 16) throw new Error('Tool schema exceeds depth limit');
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (['$ref', '$dynamicRef', 'patternProperties'].includes(key)) throw new Error('Tool schema references and patternProperties are unsupported');
      if (key === 'pattern' && (typeof entry !== 'string' || !/^\^\[[a-zA-Z0-9_.\/-]+\][+*?]?\$$/.test(entry))) {
        throw new Error('Tool schema pattern must be a bounded character class');
      }
      inspect(entry, depth + 1);
    }
  };
  inspect(schema, 0);
  return new Ajv({ strict: true }).compile(schema);
}

export function checkProposalToolParameterPaths(value: unknown): void {
  if (typeof value === 'string' && (/^[/\\]|^[a-zA-Z]:[/\\]|^file:/i.test(value))) throw new Error('Model parameters cannot select absolute paths');
  if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    checkProposalToolParameterPaths(key);
    checkProposalToolParameterPaths(entry);
  }
}

export function validateProposalToolCases(payload: ToolPayload): void {
  const validInput = compileProposalToolSchema(payload.inputSchema);
  const validOutput = compileProposalToolSchema(payload.outputSchema);
  const normal = payload.tests.filter(entry => entry.kind === 'normal');
  const parameters = normal.map(entry => {
    const value: unknown = JSON.parse(entry.input);
    checkProposalToolParameterPaths(value);
    if (!validInput(value) || !validOutput(JSON.parse(entry.expected))) throw new Error('Normal tool case does not satisfy input/output schemas');
    return canonicalLearningJson(value);
  });
  if (new Set(parameters).size < 2) throw new Error('Tool verification requires two distinct valid parameter sets');
  const refusals = payload.tests.filter(entry => entry.kind === 'refusal');
  if (!refusals.length || refusals.some(entry => {
    try { return validInput(JSON.parse(entry.input)); } catch { return false; }
  })) throw new Error('Malicious refusal cases must contain schema-invalid input');
}
