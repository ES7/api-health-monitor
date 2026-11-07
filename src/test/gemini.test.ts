import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseGeminiChat } from '../providers/geminiCli';
import { jsonl, tmpDir, write } from './helpers';

test('gemini: JSONL with tokens arriving via $patch; cached is part of input; thoughts billed as output', async () => {
    const t = tmpDir();
    try {
        const f = write(path.join(t.dir, 'tmp', 'myproj', 'chats', 'session-2026-10-01T10-00-abcd1234.jsonl'), jsonl(
            { sessionId: 'abcd1234-x', projectHash: 'h', startTime: '2026-10-01T10:00:00Z', lastUpdated: '2026-10-01T10:00:00Z', directories: ['/home/me/proj'] },
            { id: 'u1', timestamp: '2026-10-01T10:00:01Z', type: 'user', content: [{ text: 'Explain   this repo' }] },
            { id: 'g1', timestamp: '2026-10-01T10:00:05Z', type: 'gemini', model: 'gemini-3.1-pro', content: [{ text: '...' }] },
            { $patch: { updates: [{ id: 'g1', tokens: { input: 1000, output: 100, cached: 600, thoughts: 40, tool: 10, total: 1150 } }] } },
            { $set: { summary: 'Repo walkthrough' } },
            { $rewindTo: 'g1' },
        ));
        const r = await parseGeminiChat(f);
        assert.equal(r.records.length, 1, 'rewind does not erase spent tokens');
        const x = r.records[0];
        assert.equal(x.input, 1000 - 600 + 10);
        assert.equal(x.cacheRead, 600);
        assert.equal(x.output, 140);
        assert.equal(x.reasoning, 40);
        assert.equal(x.project, '/home/me/proj');
        assert.equal(r.sessions[0].title, 'Repo walkthrough');
    } finally { t.cleanup(); }
});

test('gemini: legacy single-document JSON sessions', async () => {
    const t = tmpDir();
    try {
        const f = write(path.join(t.dir, 'tmp', 'hash123', 'chats', 'session-old.json'), JSON.stringify({
            sessionId: 'old', messages: [
                { id: 'a', type: 'user', timestamp: '2025-12-01T00:00:00Z', content: 'hi' },
                { id: 'b', type: 'gemini', model: 'gemini-2.5-flash', timestamp: '2025-12-01T00:00:02Z', tokens: { input: 50, output: 5, cached: 0, thoughts: 0, tool: 0, total: 55 } },
            ],
        }));
        const r = await parseGeminiChat(f);
        assert.equal(r.records.length, 1);
        assert.equal(r.records[0].project, 'hash123', 'falls back to the per-project folder name');
        assert.equal(r.sessions[0].title, 'hi');
    } finally { t.cleanup(); }
});
