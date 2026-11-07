import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseClaudeFile } from '../providers/claudeCode';
import { jsonl, tmpDir, write } from './helpers';

const assistant = (id: string, req: string, usage: object, extra: object = {}) => ({
    type: 'assistant', sessionId: 's1', cwd: '/work/app', timestamp: '2026-10-01T10:00:00.000Z', requestId: req,
    message: { id, model: 'claude-opus-5-5', role: 'assistant', usage }, ...extra,
});

test('claude: merges repeated lines of one response, keeping the final (max) counts', async () => {
    const t = tmpDir();
    try {
        const f = write(path.join(t.dir, 's1.jsonl'), jsonl(
            { type: 'user', sessionId: 's1', cwd: '/work/app', message: { role: 'user', content: 'Fix   the login bug' } },
            assistant('m1', 'r1', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 7 }),
            assistant('m1', 'r1', { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 249,
                cache_creation: { ephemeral_1h_input_tokens: 30 }, output_tokens_details: { thinking_tokens: 20 } }),
            assistant('m2', 'r2', { input_tokens: 1, output_tokens: 5 }),
            { type: 'assistant', sessionId: 's1', timestamp: '2026-10-01T10:00:00Z', message: { id: 'x', model: '<synthetic>', usage: { output_tokens: 9 } } },
        ));
        const r = await parseClaudeFile(f);
        assert.equal(r.records.length, 2, 'two unique responses, synthetic ignored');
        const m1 = r.records.find(x => x.id.includes('m1'))!;
        assert.equal(m1.output, 249);
        assert.equal(m1.cacheWrite1h, 30);
        assert.equal(m1.cacheWrite, 20, '5-minute writes = total minus 1-hour writes');
        assert.equal(m1.reasoning, 20);
        assert.equal(m1.project, '/work/app');
        assert.equal(r.sessions[0].title, 'Fix the login bug', 'falls back to first prompt');
    } finally { t.cleanup(); }
});

test('claude: custom title wins over first prompt', async () => {
    const t = tmpDir();
    try {
        const f = write(path.join(t.dir, 's1.jsonl'), jsonl(
            { type: 'user', sessionId: 's1', message: { content: 'hello' } },
            { type: 'custom-title', customTitle: 'Release prep', sessionId: 's1' },
            assistant('m1', 'r1', { input_tokens: 1, output_tokens: 1 }),
        ));
        const r = await parseClaudeFile(f);
        assert.equal(r.sessions[0].title, 'Release prep');
    } finally { t.cleanup(); }
});
