import { fileURLToPath } from 'node:url';
import { createManagedPlaywrightPlugin } from '@afk/runtime/plugin-sdk';
export default options => createManagedPlaywrightPlugin({ ...options, packageRoot: fileURLToPath(new URL('.', import.meta.url)) });
