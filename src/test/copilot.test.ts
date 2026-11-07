import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { applyPatch, parseCopilotSession } from '../providers/copilotChat';
import { jsonl, tmpDir, write } from './helpers';

test('copilot: patch replay handles set, append and truncate-then-append', () => {
    let s: any = applyPatch({}, { kind: 0, v: { requests: [], title: 'a' } });
    s = applyPatch(s, { kind: 2, k: ['requests'], v: [{ id: 1 }, { id: 2 }] });
    s = applyPatch(s, { kind: 1, k: ['requests', 1, 'result'], v: { ok: true } });
    s = applyPatch(s, { kind: 2, k: ['requests'], v: [{ id: 3 }], i: 1 });
    assert.deepEqual(s.requests.map((r: any) => r.id), [1, 3]);
    s = applyPatch(s, { kind: 1, k: ['nested', 'deep'], v: 5 });
    assert.equal(s.nested.deep, 5);
});

test('copilot: JSONL session yields prompt/output tokens, resolved model, workspace and no cost', async () => {
    const t = tmpDir();
    try {
        write(path.join(t.dir, 'abc', 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/Users/me/Portfolio' }));
        const f = write(path.join(t.dir, 'abc', 'chatSessions', 's1.jsonl'), jsonl(
            { kind: 0, v: { sessionId: 's1', requests: [] } },
            { kind: 1, k: ['customTitle'], v: 'Privacy page' },
            { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: 1779346080988, modelId: 'copilot/auto', message: { text: 'make a page' } }] },
            { kind: 1, k: ['requests', 0, 'result'], v: { metadata: { promptTokens: 19662, outputTokens: 89, resolvedModel: 'claude-sonnet-4.5' } } },
            { kind: 1, k: ['requests', 0, 'completionTokens'], v: 2005 },
        ));
        const r = await parseCopilotSession(f);
        assert.equal(r.records.length, 1);
        const x = r.records[0];
        assert.equal(x.input, 19662);
        assert.equal(x.output, 2005, 'total output across rounds');
        assert.equal(x.model, 'claude-sonnet-4.5');
        assert.equal(x.costUsd, 0);
        assert.equal(x.project, 'c:/Users/me/Portfolio');
        assert.equal(r.sessions[0].title, 'Privacy page');
    } finally { t.cleanup(); }
});

test('copilot: legacy JSON session without token data still counts requests', async () => {
    const t = tmpDir();
    try {
        const f = write(path.join(t.dir, 'h', 'chatSessions', 's2.json'), JSON.stringify({
            sessionId: 's2', requests: [{ requestId: 'a', timestamp: 1765786234482, modelId: 'copilot/gpt-4.1', message: { text: 'q' }, result: {} }],
        }));
        const r = await parseCopilotSession(f);
        assert.equal(r.records.length, 1);
        assert.equal(r.records[0].model, 'gpt-4.1');
        assert.equal(r.records[0].input + r.records[0].output, 0);
    } finally { t.cleanup(); }
});
