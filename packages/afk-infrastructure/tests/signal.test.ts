import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGNAL_TYPES } from '@afk/core';
import { SIGNAL_FILE, SignalFileError, readSignal, readSignalSync, writeSignal } from '../src/io/signal.js';
import { SignalSchema } from '../src/schemas.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'afk-signal-'));
  roots.push(root);
  return root;
}

const VALID = { type: 'goal_complete' as const, timestamp: new Date().toISOString(), summary: 'implemented' };

describe('writeSignal', () => {
  it('writes a signal the readers can read back', async () => {
    const dir = await workspace();

    await writeSignal(VALID, dir);

    await expect(readSignal(dir)).resolves.toEqual(VALID);
    expect(readSignalSync(dir)).toEqual(VALID);
  });

  it('refuses a signal the readers would not accept, and leaves nothing behind', async () => {
    const dir = await workspace();
    // An empty summary breaks the schema's grammar: the file would sit
    // where every reader looks and still be invisible to all of them.
    await expect(writeSignal({ ...VALID, summary: '' }, dir)).rejects.toThrow(SignalFileError);
    await expect(readFile(join(dir, SIGNAL_FILE), 'utf8')).rejects.toThrow();
    await expect(readFile(join(dir, `${SIGNAL_FILE}.tmp`), 'utf8')).rejects.toThrow();
  });
});

describe('readSignal', () => {
  it('reports no signal when there is no file', async () => {
    const dir = await workspace();

    await expect(readSignal(dir)).resolves.toBeNull();
    expect(readSignalSync(dir)).toBeNull();
  });

  it('reports no signal while the writer has not finished the file', async () => {
    const dir = await workspace();
    await writeFile(join(dir, SIGNAL_FILE), '');

    await expect(readSignal(dir)).resolves.toBeNull();
    expect(readSignalSync(dir)).toBeNull();
  });

  it('says the file is broken instead of reporting no signal', async () => {
    const dir = await workspace();
    await writeFile(join(dir, SIGNAL_FILE), '{not json');

    await expect(readSignal(dir)).rejects.toThrow(SignalFileError);
    expect(() => readSignalSync(dir)).toThrow(SignalFileError);
  });

  it('says the signal breaks the grammar instead of reporting no signal', async () => {
    const dir = await workspace();
    await writeFile(join(dir, SIGNAL_FILE), JSON.stringify({ ...VALID, summary: '' }));

    await expect(readSignal(dir)).rejects.toThrow(SignalFileError);
    expect(() => readSignalSync(dir)).toThrow(SignalFileError);
  });

  it('agrees with itself on a file it cannot read at all', async () => {
    const dir = await workspace();
    await mkdir(join(dir, SIGNAL_FILE));

    // Both readers fail the same way. One used to fail and the other
    // shrug, so the same directory looked broken to one caller and empty
    // to the next.
    await expect(readSignal(dir)).rejects.toThrow();
    expect(() => readSignalSync(dir)).toThrow();
  });
});

describe('the signal grammar and the signal vocabulary', () => {
  it('accepts exactly the signals the vocabulary names', () => {
    // The vocabulary is what a caller reads to learn which signals
    // exist, and the grammar is what a file has to satisfy. A signal the
    // vocabulary does not name cannot be waited for, and a signal the
    // vocabulary names but the grammar refuses can never be written.
    const accepted = SignalSchema.options.map(option => option.shape.type.value).sort();
    expect(accepted).toEqual([...SIGNAL_TYPES].sort());
  });
});
