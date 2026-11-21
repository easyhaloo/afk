import { z } from 'zod';
import { learningDigestSchema, learningIdentitySchema } from './requests.js';
import { learningExecutionBindingSchema, learningExecutionOwnershipSchema } from './execution-ownership.js';

export const proposalRuntimeBindingSchema = learningExecutionBindingSchema;
export const proposalExecutionOwnershipSchema = learningExecutionOwnershipSchema;
export const proposalOwnershipRegistrationSchema = z.object({
  ownership: proposalExecutionOwnershipSchema,
  binding: proposalRuntimeBindingSchema,
  check: z.object({ checkId: learningIdentitySchema, checkDigest: learningDigestSchema, version: z.enum(['original', 'proposed']),
    configurationDigest: learningDigestSchema, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    inventoryDigest: learningDigestSchema, artifactDigest: learningDigestSchema,
    artifactPath: z.string().min(1).max(4096).refine(value => !/[\\\x00-\x1f\x7f]/.test(value)
      && !value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')),
    workspaceId: learningIdentitySchema, runId: learningIdentitySchema,
  }).strict(),
}).strict();

export type ProposalOwnershipRegistration = z.infer<typeof proposalOwnershipRegistrationSchema>;
