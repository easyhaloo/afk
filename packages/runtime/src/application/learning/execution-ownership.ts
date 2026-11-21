import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { learningScopeSchema } from './contracts.js';
import { learningDigestSchema, learningIdentitySchema } from './requests.js';

export const learningExecutionBindingSchema = z.object({ scope: learningScopeSchema, candidateId: learningDigestSchema,
  candidateVersion: z.number().int().positive().safe(), evidenceDigest: learningDigestSchema }).strict();
export const learningExecutionOwnershipSchema = z.object({ operationId: z.string().uuid(), engine: z.literal('docker'),
  containerName: learningIdentitySchema, baseImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  inputDigest: learningDigestSchema, contextDigest: learningDigestSchema }).strict()
  .refine(value => value.containerName === `afk-frozen-${value.operationId}`);
export const factWorkspaceSchema = z.object({ kind: z.enum(['repository', 'sandbox']), providerId: learningIdentitySchema,
  id: learningIdentitySchema, cwd: z.string().min(1).max(4096)
    .refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value)),
  revision: learningIdentitySchema }).strict();
export const factOwnershipRegistrationSchema = z.object({
  ownership: learningExecutionOwnershipSchema,
  binding: learningExecutionBindingSchema,
  check: z.object({ executionId: learningIdentitySchema, checkerId: learningIdentitySchema, checkerVersion: learningIdentitySchema,
    configurationDigest: learningDigestSchema, authorizationDigest: learningDigestSchema,
    checkerDigest: learningDigestSchema, requestDigest: learningDigestSchema, targetDigest: learningDigestSchema,
    workspace: factWorkspaceSchema, leaseId: learningIdentitySchema,
  }).strict(),
}).strict();

export type FactOwnershipRegistration = z.infer<typeof factOwnershipRegistrationSchema>;
