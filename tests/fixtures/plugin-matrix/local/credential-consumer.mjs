import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  manifest: { id: 'context.matrix-credential-probe', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], requires: ['credential.provider'], trusted: true, entry: 'index.js' },
  activate(context) {
    context.registerContextProvider('matrix-credential-probe', {
      id: 'matrix-credential-probe',
      capabilities: { 'read-only': true, summarize: false, search: false },
      async gather(query) {
        const providerId = process.env.PLUGIN_MATRIX_CREDENTIAL;
        const provider = context.getCredentialProvider(providerId);
        if (!provider) throw new Error('Matrix credential provider is not active');
        const { secret } = await provider.resolve({ name: query.scope, ...(query.prompt ? { scope: query.prompt } : {}) });
        const digest = createHash('sha256').update(secret).digest('hex');
        await writeFile(join(process.env.PLUGIN_MATRIX_OUTPUT, 'credential-receipt.json'), JSON.stringify({ provider: providerId, digest, length: secret.length }));
        return [{ origin: providerId, content: digest }];
      },
    });
  },
};
