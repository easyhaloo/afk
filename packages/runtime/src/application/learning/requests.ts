import { z } from 'zod';
import { DISTILLATION_LIMITS, distillationKey, distillationRequestSchema, evidenceRefSchema } from './contracts.js';

export const learningIdentitySchema = z.string().trim().min(1).max(512).refine(value => !/[\0\r\n\t]/.test(value));
export const learningDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const blockedReasonSchema = z.string().trim().min(1).max(2048).refine(value => !value.includes('\0'));
const submissionSchema = z.object({
  request: distillationRequestSchema, evidence: z.array(evidenceRefSchema).max(4096),
  blockedReason: blockedReasonSchema.optional(),
}).strict();

export type DistillationSubmission = z.input<typeof submissionSchema>;
export type PreparedDistillationRequest = z.infer<typeof submissionSchema> & { key: string };

export function canonicalLearningJson(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new Error('Expected JSON learning data');
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order);
    if (value !== null && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
        .map(([key, entry]) => [key, order(entry)]));
    return value;
  };
  return JSON.stringify(order(JSON.parse(serialized)));
}

export function prepareDistillationRequest(input: DistillationSubmission): PreparedDistillationRequest {
  const parsed = submissionSchema.parse(input);
  if (!parsed.evidence.length && !parsed.blockedReason) throw new Error('Missing evidence requires an explicit blocked reason');
  if (new Set(parsed.evidence.map(entry => entry.id)).size !== parsed.evidence.length) throw new Error('Duplicate evidence IDs');
  if (Buffer.byteLength(canonicalLearningJson(parsed.evidence)) > DISTILLATION_LIMITS.evidenceBytes) throw new Error('Evidence references exceed size limit');
  parsed.evidence.sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
  return { ...parsed, key: distillationKey(parsed.request) };
}
