import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configuredPluginManifests } from '../../../packages/runtime/src/application/plugins/configured.ts';

const matrix = readFileSync(new URL('matrix.tsv', import.meta.url), 'utf8');
const [header, ...lines] = matrix.trimEnd().split(/\r?\n/);
const fields = header.split('\t');
assert.equal(header, 'family\trow\tconfig_id\timplementation_src\twiring\tcontract_suite\tfixture_or_local\taudit_cases\tconfig_inputs\tevidence_level\tindependent_or_account\tgap_next');
const rows = lines.map((line, index) => {
  const values = line.split('\t');
  assert.equal(values.length, fields.length, `line ${index + 2}`);
  assert.ok(values.every(value => value.trim()), `empty cell on line ${index + 2}`);
  return Object.fromEntries(fields.map((key, column) => [key, values[column]]));
});
assert.equal(rows.length, 55);
assert.equal(new Set(rows.map(record => record.row)).size, 55);
assert.equal(new Set(rows.map(record => record.family)).size, 13);
const expectedIds = configuredPluginManifests().map(manifest => manifest.id).filter(id => id !== 'learning.distiller');
const ids = new Set(rows.map(record => record.config_id).filter(id => id !== '—'));
assert.deepEqual(ids, new Set(expectedIds));
assert.equal(ids.size, 51);
const builtins = new Set(['observe.local-logs', 'observe.local-events', 'observe.evidence']);
const signals = new Set(['observe.otlp-tracing', 'observe.otlp-metrics']);
const levels = new Set(['account', 'service', 'native', 'local', 'partial', 'fixture']);
for (const record of rows) {
  const id = builtins.has(record.row) ? '—' : signals.has(record.row) ? 'observability.otlp' : record.row;
  assert.equal(record.config_id, id, record.row);
  assert.ok(levels.has(record.evidence_level), record.row);
  for (const path of [record.implementation_src, record.contract_suite]) assert.ok(statSync(path).isFile(), path);
}
console.log('55 rows, 13 families, 51 configured IDs. Source and contract paths verified.');
console.log(Object.fromEntries([...levels].map(level => [level, rows.filter(record => record.evidence_level === level).length])));

const auditDir = process.env.W10_AUDIT_DIR;
if (auditDir) {
  const auditText = readFileSync(join(auditDir, 'provider-matrix.json'));
  assert.equal(createHash('sha256').update(auditText).digest('hex'), '19f3401ce59ff0f3739ddca34d35a53b62450cc5865b223575fe93015564de83');
  const { providers } = JSON.parse(auditText);
  const { installedPassedCases } = JSON.parse(readFileSync(join(auditDir, 'evidence-index.json'), 'utf8'));
  assert.deepEqual(rows.map(record => record.row), providers.map(provider => provider.id));
  for (const [index, record] of rows.entries()) {
    const cases = record.audit_cases === '—' ? [] : record.audit_cases.split(',');
    assert.deepEqual(cases, [...new Set(providers[index].stages.installed.caseIds)], record.row);
    for (const id of cases) assert.equal(installedPassedCases[id]?.status, 'passed', `${record.row} ${id}`);
  }
  console.log('Original audit digest, row order, per-row case IDs and indexed pass statuses verified.');
} else {
  console.log('Historical audit not checked. Set W10_AUDIT_DIR to include it.');
}
