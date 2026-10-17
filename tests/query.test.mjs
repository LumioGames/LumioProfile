import test from 'node:test';
import assert from 'node:assert/strict';
import { querySql, parseCsv } from '../packages/profile-tools/src/query.ts';
test('Agent and UI share versioned bounded queries with safely quoted operation keys', () => {
  const sql = querySql('operation', "session/o'42"); assert.ok(sql, 'query must exist');
  assert.match(sql, /session\/o''42/);
  assert.match(sql, /LIMIT 1000/);
  assert.match(querySql('hotspots'), /observedSelfMs/);
  assert.throws(() => querySql('arbitrary'), /unknown-query/);
});
test('CSV decoding handles quoted commas and escaped quotes from Trace Processor', () => {
  const rows = parseCsv('"name","value"\n"work, main",9\n"a""b",[NULL]\n');
  assert.ok(rows); assert.deepEqual(rows, [{ name: 'work, main', value: 9 }, { name: 'a"b', value: null }]);
});
