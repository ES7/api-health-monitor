import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { clineFamily, parseClineTask } from '../providers/clineFamily';
import { SessionInfo, UsageRecord } from '../core/types';
import { tmpDir, write } from './helpers';

const req = (ts: number, o: object) => ({ ts, type: 'say', say: 'api_req_started', text: JSON.stringify({ request: '<task>…</task>', ...o }) });

test('cline: per-request tokens, reported cost and model history', async () => {
    const t = tmpDir();
    try {
        const task = path.join(t.dir, 'tasks', '1000');
        write(path.join(task, 'task_metadata.json'), JSON.stringify({ model_usage: [
            { ts: 1000, model_id: 'claude-sonnet-4-5', model_provider_id: 'anthropic' },
            { ts: 5000, model_id: 'gemini-2.5-pro', model_provider_id: 'gemini' },
        ] }));
        const f = write(path.join(task, 'ui_messages.json'), JSON.stringify([
            { ts: 1001, type: 'say', say: 'text', text: 'hi' },
            req(2000, { tokensIn: 100, tokensOut: 10, cacheWrites: 5, cacheReads: 50, cost: 0.01 }),
            req(6000, { tokensIn: 200, tokensOut: 20, cacheWrites: 0, cacheReads: 0, cost: 0 }),
            req(7000, { request: 'cancelled before any usage' }),
        ]));
        const r = await parseClineTask(f, 'cline');
        assert.equal(r.records.length, 2);
        assert.deepEqual(r.records.map(x => x.model), ['claude-sonnet-4-5', 'gemini-2.5-pro']);
        assert.equal(r.records[0].costUsd, 0.01);
        assert.equal(r.records[1].costUsd, 0, 'a reported zero (free model) is kept as zero');
        assert.equal(r.records[0].cacheRead, 50);
    } finally { t.cleanup(); }
});

test('cline: a task with a truncated log is still counted from taskHistory totals', async () => {
    const t = tmpDir();
    try {
        write(path.join(t.dir, 'state', 'taskHistory.json'), JSON.stringify([
            { id: '2000', ts: 1764657722461, task: 'Deploy   this project', tokensIn: 1000, tokensOut: 50, cacheReads: 10, cacheWrites: 0, totalCost: 0.4, cwdOnTaskInitialization: 'c:\\bot' },
        ]));
        const p = clineFamily({ id: 'cline', name: 'Cline', color: '#000', extensionIds: [] });
        const sessions = new Map<string, SessionInfo>();
        const records: UsageRecord[] = [];
        await p.enrich!({ extraPaths: [] }, [t.dir], sessions, records);
        assert.equal(records.length, 1);
        assert.equal(records[0].costUsd, 0.4);
        assert.equal(records[0].project, 'c:\\bot');
        assert.equal(sessions.get('cline:2000')?.title, 'Deploy this project');
    } finally { t.cleanup(); }
});
