import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { SqlJsStatic } from 'sql.js';
import { parseOpencodeDb, parseOpencodeSessionDir } from '../providers/opencode';
import { tmpDir, write } from './helpers';

const msg = (id: string, sessionID: string, extra: object = {}) => ({
    id, sessionID, role: 'assistant', time: { created: 1790000000000 }, modelID: 'claude-sonnet-5-5', providerID: 'anthropic',
    cost: 0.02, tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 100, write: 30 } }, path: { cwd: '/repo' }, ...extra,
});

test('opencode: legacy per-message JSON files', async () => {
    const t = tmpDir();
    try {
        const d = path.join(t.dir, 'storage', 'message', 'ses_1');
        write(path.join(d, 'msg_1.json'), JSON.stringify(msg('msg_1', 'ses_1')));
        write(path.join(d, 'msg_2.json'), JSON.stringify({ id: 'msg_2', sessionID: 'ses_1', role: 'user', time: { created: 1 } }));
        write(path.join(d, 'msg_3.json'), JSON.stringify(msg('msg_3', 'ses_1', { cost: 0 })));
        const r = await parseOpencodeSessionDir(d);
        assert.equal(r.records.length, 2, 'user messages ignored');
        assert.equal(r.records[0].cacheRead, 100);
        assert.equal(r.records[0].costUsd, 0.02);
        assert.equal(r.records[1].costUsd, undefined, 'zero cost means not computed: estimate instead');
        assert.equal(r.records[0].project, '/repo');
    } finally { t.cleanup(); }
});

test('opencode: SQLite database (v1.2+)', async () => {
    const t = tmpDir();
    try {
        const initSqlJs = require('sql.js') as (c: unknown) => Promise<SqlJsStatic>;
        const SQL = await initSqlJs({ locateFile: (f: string) => path.join(path.dirname(require.resolve('sql.js')), f) });
        const db = new SQL.Database();
        db.run('create table message (id text, session_id text, data text)');
        db.run('create table session (id text, title text, directory text)');
        db.run('insert into message values (?, ?, ?)', ['m1', 'ses_9', JSON.stringify(msg('m1', 'ses_9'))]);
        db.run('insert into session values (?, ?, ?)', ['ses_9', 'Refactor auth', '/repo']);
        const f = path.join(t.dir, 'opencode.db');
        fs.writeFileSync(f, Buffer.from(db.export()));
        db.close();
        const r = await parseOpencodeDb(f);
        assert.equal(r.records.length, 1);
        assert.equal(r.sessions.find(s => s.id === 'ses_9')?.title, 'Refactor auth');
        assert.equal(r.unreadable, false);
    } finally { t.cleanup(); }
});
