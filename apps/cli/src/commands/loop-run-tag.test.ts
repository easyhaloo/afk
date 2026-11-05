import { describe, expect, it } from 'vitest';
import { chooseCommandRunTag } from './loop-run-tag.js';

describe('choosing the run a loop command acts on', () => {
  it('acts on the default run when it is alive', () => {
    expect(chooseCommandRunTag(undefined, ['default', 'k-base-3-ab12cd'])).toEqual({ tag: 'default' });
  });

  it('acts on the only live run', () => {
    expect(chooseCommandRunTag(undefined, ['k-base-3-ab12cd'])).toEqual({ tag: 'k-base-3-ab12cd' });
  });

  it('refuses to guess between several live runs', () => {
    // Guessing `default` here made `status` print "not running" and exit 0
    // while two loops were working.
    expect(chooseCommandRunTag(undefined, ['k-base-3-ab12cd', 'api-42-0011aa'])).toEqual({
      ambiguous: ['k-base-3-ab12cd', 'api-42-0011aa'],
    });
  });

  it('falls back to the default tag when nothing is running', () => {
    expect(chooseCommandRunTag(undefined, [])).toEqual({ tag: 'default' });
  });

  it('honours an explicit tag over the live list', () => {
    expect(chooseCommandRunTag('api-42-0011aa', ['default'])).toEqual({ tag: 'api-42-0011aa' });
    expect(chooseCommandRunTag('my run', [])).toEqual({ tag: 'my-run' });
  });

  it('rejects an explicit tag that would leave the runs directory', () => {
    expect(() => chooseCommandRunTag('..', [])).toThrow(/invalid loop run tag/);
    expect(() => chooseCommandRunTag('.', [])).toThrow(/invalid loop run tag/);
  });
});
