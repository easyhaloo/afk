import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { learningScopeSchema } from './contracts.js';
import { learningDigestSchema, learningIdentitySchema } from './requests.js';
import { readValidationPrivateFile } from './validation-files.js';

export const sourceReadPathSchema = z.string().min(1).max(4096)
  .refine(path => isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path));
const grantSchema = z.object({
  scope: learningScopeSchema, targetRef: learningIdentitySchema, evidenceDigest: learningDigestSchema,
  revoked: z.boolean(), paths: z.array(sourceReadPathSchema).max(128),
}).strict();
const fileSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema).max(256) }).strict();
export type KnowledgeSourceReadGrant = z.infer<typeof grantSchema>;
export type CheckSourceRead = (path?: string) => void;

export function sourceReadCheck(file: string | undefined, scope: string,
  publication: { targetRef: string; evidenceDigest: string }): CheckSourceRead | undefined {
  if (file === undefined) return undefined;
  return path => {
    const bytes = readValidationPrivateFile(file).bytes;
    const { grants } = fileSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const matches = grants.filter(grant => grant.scope === scope && grant.targetRef === publication.targetRef
      && grant.evidenceDigest === publication.evidenceDigest);
    if (matches.length !== 1 || matches[0]!.revoked || (path !== undefined && !matches[0]!.paths.includes(path))) {
      throw new Error('knowledge_source_read_denied');
    }
  };
}
