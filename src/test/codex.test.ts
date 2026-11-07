import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as zlib from 'zlib';
import { parseCodexFile } from '../providers/codex';
import { jsonl, tmpDir, write } from './helpers';

const meta = { timestamp: '2026-05-17T10:00:00Z', type: 'session_meta', payload: { id: 'sess-1', cwd: 'C:\\code\\app' } };
const ctx = (model: string) => ({ timestamp: '2026-05-17T10:00:01Z', type: 'turn_context', payload: { model } });
const total = (ts: string, input: number, cached: number, output: number) => ({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } },
});

test('codex: running totals win over per-response records that only cover a resumed tail', async () => {
    const t = tmpDir();
    try {
        const f = write(path.join(t.dir, 'rollout-a.jsonl'), jsonl(
            meta, ctx('gpt-5.4'),
            total('2026-05-17T10:01:00Z', 1000, 400, 100),
            total('2026-05-17T10:01:00Z', 1000, 400, 100), // duplicate event, no change
            total('2026-05-17T10:02:00Z', 3000, 2000, 300),
            // resumed in a newer build: only the last response has a token_usage_record
            ctx('gpt-5.5'),
            { timestamp: '2026-05-17T11:00:00Z', type: 'token_usage_record', payload: { response_id: 'r9', usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 50 } } },
            total('2026-05-17T11:00:00Z', 3500, 2000, 350),
        ));
        const r = await parseCodexFile(f);
        const sum = (k: 'input' | 'cacheRead' | 'output') => r.records.reduce((a, x) => a + x[k], 0);
        assert.equal(r.records.length, 3);
        assert.equal(sum('input') + sum('cacheRead'), 3500, 'input incl. cache equals final total');
        assert.equal(sum('cacheRead'), 2000);
        assert.equal(sum('output'), 350);
        assert.equal(r.records[0].project, 'C:\\code\\app');
        assert.equal(r.records[2].model, 'gpt-5.5', 'model follows turn_context');
    } finally { t.cleanup(); }
});

test('codex: reads zstd-compressed rollouts, counter resets and rate limits', async (tt) => {
    const zstd = (zlib as any).zstdCompressSync;
    if (typeof zstd !== 'function') { tt.skip('this Node has no zstd compressor'); return; }
    const t = tmpDir();
    try {
        const body = jsonl(
            meta, ctx('gpt-5.6-luna'),
            total('2026-09-29T06:00:00Z', 100, 0, 10),
            total('2026-09-29T06:05:00Z', 40, 0, 5), // counter restarted
            { timestamp: '2026-09-29T06:06:00Z', type: 'event_msg', payload: { type: 'token_count', info: null,
                rate_limits: { plan_type: 'go', primary: { used_percent: 9, window_minutes: 43200, resets_at: 1793251001 } } } },
        );
        const f = write(path.join(t.dir, 'rollout-b.jsonl.zst'), zstd(Buffer.from(body)));
        const r = await parseCodexFile(f);
        assert.equal(r.records.reduce((a, x) => a + x.input + x.output, 0), 155);
        assert.equal(r.rateLimit?.plan, 'go');
        assert.equal(r.rateLimit?.primary?.usedPercent, 9);
        assert.equal(r.rateLimit?.primary?.resetsAt, 1793251001000);
    } finally { t.cleanup(); }
});
