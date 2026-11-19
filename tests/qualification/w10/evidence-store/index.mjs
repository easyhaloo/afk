import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url)));
const blob = bytes => `X'${Buffer.from(bytes).toString('hex')}'`;
const text = value => `CAST(${blob(value)} AS TEXT)`;
const query = input => execFileSync('sqlite3', ['-batch', '-bail', '-json', process.env.W10_DB],
  { input, encoding: 'utf8', timeout: 5000 });

export default {
  manifest,
  activate(context) {
    context.registerCapability('observe.evidence', 'sqlite', {
      id: 'sqlite', capabilities: { put: true, get: true, classify: false },
      async put({ id, mediaType, classification, bytes }) {
        query(`BEGIN;
          INSERT INTO calls VALUES ('put', ${text(id)}, ${bytes.byteLength});
          INSERT INTO records VALUES (${text(id)}, ${text(mediaType)}, ${text(classification)}, ${blob(bytes)});
          COMMIT;`);
        return { name: id, uri: `sqlite:records/${id}` };
      },
      async get(id) {
        const [row] = JSON.parse(query(`INSERT INTO calls VALUES ('get', ${text(id)}, 0);
          SELECT id, mediaType, classification, hex(bytes) AS payload FROM records WHERE id = ${text(id)};`) || '[]');
        return row && { ...row, bytes: Buffer.from(row.payload, 'hex') };
      },
    });
  },
};
