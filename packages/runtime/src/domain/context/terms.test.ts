import { expect, it } from 'vitest';
import { lexicalTerms } from './terms.js';

it('segments Chinese prose beside exact error and tool identifiers', () => {
  expect(lexicalTerms('磁盘空间不足 ENOSPC build-cache/v2 --retry-delay=10')).toEqual(expect.arrayContaining([
    '磁盘', '空间', '不足', 'enospc', 'build-cache/v2', 'retry-delay', '10',
  ]));
  expect(lexicalTerms(' ，！？\n')).toEqual([]);
});
