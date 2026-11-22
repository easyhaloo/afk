import { z } from 'zod';

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0'));

export const artifactRefSchema = z.object({
  uri: text,
  name: text,
  storedContent: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: text }).optional(),
});
