import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(import.meta.url);
const id = basename(path, '.js');
export default {
  id,
  async setup(ctx) {
    await ctx.skill.transform(registry => {
      registry.add({ id, name: id, description: 'Read the local clock format.', path, content: 'Time format is HH:mm.' });
    });
    await ctx.session.hook('prompt', async () => {
      const label = `${id}-prompt`;
      await ctx.skill.transform(registry => {
        registry.add({ id: label, name: label, description: 'Display a timestamp.', path, content: 'Use a UTC timestamp.' });
      });
    });
  },
};
