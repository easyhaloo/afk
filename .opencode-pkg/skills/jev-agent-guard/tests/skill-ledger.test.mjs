import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadLedger, recordAction, recordSkill } from '../scripts/skill-ledger.mjs';

test('ledger isolates projects and stores only bounded evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev ledger '));
  try {
    const env = { HOME: directory, XDG_STATE_HOME: path.join(directory, 'state') };
    recordSkill({ host: 'claude-code', sessionId: 'same-session', projectRoot: '/project-a' },
      { name: 'debug', steps: ['Reproduce failure'], constraints: [] }, env);
    recordAction({ host: 'claude-code', sessionId: 'same-session', projectRoot: '/project-a' },
      { tool: 'Bash', success: false, command: 'password=super-secret' }, env);
    const first = loadLedger({ host: 'claude-code', sessionId: 'same-session', projectRoot: '/project-a' }, env);
    assert.equal(first.skill.name, 'debug');
    assert.equal(first.evidence[0].tool, 'Bash');
    assert.equal(first.evidence[0].success, false);
    assert.equal(loadLedger({ host: 'claude-code', sessionId: 'same-session', projectRoot: '/project-b' }, env), null);
    assert.doesNotMatch(JSON.stringify(first), /super-secret|password=/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
