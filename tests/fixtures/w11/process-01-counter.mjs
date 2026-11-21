import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

export const route = { entry: 'return-handoff', systems: ['退件登记簿'], preconditions: ['收到退件'], exceptions: ['自提退件不走此路径'] };
export const applicability = { preconditions: [], exclusions: ['pickup'], invalidationConditions: [] };

export function initialize(file, bag) {
  const database = new DatabaseSync(file);
  try {
    database.exec(`CREATE TABLE returns (bag TEXT PRIMARY KEY, pickup INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE transitions (prior TEXT PRIMARY KEY, action TEXT NOT NULL, next TEXT NOT NULL);
      INSERT INTO transitions VALUES ('待核对','核对袋号','已核对'),('已核对','登记签收','已签收');
      CREATE TABLE trace (seq INTEGER PRIMARY KEY, bag TEXT, action TEXT, prior TEXT, next TEXT);
      CREATE TRIGGER record AFTER UPDATE OF state ON returns BEGIN
        INSERT INTO trace(bag,action,prior,next) SELECT NEW.bag,action,OLD.state,NEW.state FROM transitions
          WHERE prior=OLD.state AND next=NEW.state;
      END;`);
    const insert = database.prepare("INSERT INTO returns VALUES (?,?, '待核对')");
    insert.run(bag, 0);
    insert.run(`${bag}-pickup`, 1);
  } finally { database.close(); }
}

export function perform(file, bag, action) {
  const database = new DatabaseSync(file);
  try {
    const result = database.prepare(`UPDATE returns SET state=(SELECT next FROM transitions WHERE prior=state AND action=?)
      WHERE bag=? AND pickup=0 AND EXISTS (SELECT 1 FROM transitions WHERE prior=state AND action=?)`).run(action, bag, action);
    assert.equal(result.changes, 1, '袋号、交接状态或自提条件不符');
    return database.prepare('SELECT action, prior, next FROM trace WHERE bag=? ORDER BY seq DESC LIMIT 1').get(bag);
  } finally { database.close(); }
}

export function observe(file, bag) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database.prepare('SELECT action, prior, next FROM trace WHERE bag=? ORDER BY seq').all(bag);
    return { ...route, steps: rows.map(row => ({ action: row.action, stateChange: `${row.prior} -> ${row.next}` })),
      completion: database.prepare('SELECT state FROM returns WHERE bag=?').get(bag).state };
  } finally { database.close(); }
}

export function checkAssertions(file, bag, assertions) {
  const observed = { ...observe(file, bag), applicability };
  return assertions.map(assertion => {
    const actual = assertion.node === 'process.stepCount' ? String(observed.steps.length)
      : assertion.node.split('.').slice(1).reduce((value, key) => value?.[key], observed);
    return { ...assertion, actual: actual ?? '', status: actual === undefined ? 'unknown' : 'observed' };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , action, bag] = process.argv;
  console.log(JSON.stringify(perform('returns.sqlite', bag, action)));
}
