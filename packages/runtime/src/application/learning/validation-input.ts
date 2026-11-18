import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { learningScopeSchema } from './contracts.js';
import { learningDigestSchema, learningIdentitySchema } from './requests.js';

const auditRoot = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const auditPin = z.object({ runId: learningIdentitySchema, root: auditRoot, auditDigest: learningDigestSchema }).strict();
export const lessonRepairConfigurationSchema = z.object({ failure: auditPin, fix: auditPin }).strict();
const auditBinding = auditPin.omit({ root: true }).extend({ auditHead: learningDigestSchema,
  auditSequence: z.number().int().positive().safe() }).strict();
export const lessonRepairBindingSchema = z.object({ failure: auditBinding, fix: auditBinding,
  failureEventId: learningIdentitySchema, fixCommitEventId: learningIdentitySchema, fixCompletionEventId: learningIdentitySchema }).strict();

export const lessonQaConfigurationSchema = z.object({ scope: learningScopeSchema, workItemId: learningIdentitySchema,
  runId: learningIdentitySchema, targetRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  root: auditRoot, auditDigest: learningDigestSchema, repair: lessonRepairConfigurationSchema.optional() }).strict();

const inputSchema = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
  expectedVersion: z.number().int().positive().safe(), checkerId: learningIdentitySchema }).strict();
export type LearningValidationInput = z.infer<typeof inputSchema>;

export function parseLearningValidationInput(input: unknown) {
  try {
    if (!input || typeof input !== 'object' || ![null, Object.prototype].includes(Object.getPrototypeOf(input))) return;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== 4 || Object.keys(inputSchema.shape).some(key =>
      !Object.hasOwn(descriptors, key) || !('value' in descriptors[key]) || !descriptors[key].enumerable)) return;
    return inputSchema.safeParse(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])));
  } catch { return; }
}
