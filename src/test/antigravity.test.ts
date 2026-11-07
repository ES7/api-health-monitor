import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { SqlJsStatic } from 'sql.js';
import { parseAntigravityDb } from '../providers/antigravity';
import { decode, getInt, getString } from '../core/protobuf';
import { pb, tmpDir } from './helpers';

test('protobuf: nested path lookups', () => {
    const buf = pb([[1, [[3, 1016], [4, [[2, 300], [3, 40]]], [21, 'Gemini 3.1 Pro (High)']]], [2, 7]]);
    assert.equal(getInt(buf, [1, 4, 2]), 300);
    assert.equal(getString(buf, [1, 21]), 'Gemini 3.1 Pro (High)');
    assert.equal(getInt(buf, [2]), 7);
    assert.equal(decode(Uint8Array.from([0x0a, 0xff])), undefined, 'truncated input is rejected, not thrown');
});

test('antigravity: reads generation usage, time and model from gen_metadata', async () => {
    const t = tmpDir();
    try {
        const initSqlJs = require('sql.js') as (c: unknown) => Promise<SqlJsStatic>;
        const SQL = await initSqlJs({ locateFile: (f: string) => path.join(path.dirname(require.resolve('sql.js')), f) });
        const db = new SQL.Database();
        db.run('create table gen_metadata (idx integer primary key, data blob, size integer)');
        const gen = (input: number, out: number, cached: number, secs: number) => pb([[1, [
            [3, 1016],
            [4, [[1, 1016], [2, input], [3, out], [5, cached], [9, Math.floor(out * 0.8)], [10, out - Math.floor(out * 0.8)]]],
            [9, [[4, [[1, secs], [2, 0]]]]],
            [21, 'Gemini 3.1 Pro (High)'],
        ]]]);
        db.run('insert into gen_metadata values (0, ?, 0)', [gen(26550, 565, 0, 1782537939)]);
        db.run('insert into gen_metadata values (1, ?, 0)', [gen(3152, 535, 24408, 1782537946)]);
        db.run('insert into gen_metadata values (2, ?, 0)', [pb([[1, [[3, 1]]]])]); // no usage: skipped
        const f = path.join(t.dir, 'conv-1.db');
        fs.writeFileSync(f, Buffer.from(db.export()));
        db.close();

        const r = await parseAntigravityDb(f);
        assert.equal(r.records.length, 2);
        assert.equal(r.records[1].input, 3152);
        assert.equal(r.records[1].cacheRead, 24408);
        assert.equal(r.records[1].output, 535);
        assert.equal(r.records[1].ts, 1782537946000);
        assert.equal(r.records[0].model, 'Gemini 3.1 Pro (High)');
    } finally { t.cleanup(); }
});
