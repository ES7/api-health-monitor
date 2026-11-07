import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { Pricer } from '../core/pricing';
import { mapLimit, Scanner } from '../core/scanner';
import { buildPayload, ROW } from '../core/payload';
import { Provider } from '../core/provider';
import { UsageRecord } from '../core/types';
import { tmpDir, write } from './helpers';

const rec = (over: Partial<UsageRecord>): UsageRecord => ({
    id: 'x', source: 's', ts: 0, model: 'm', sessionId: 'a', project: '', input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, ...over,
});

test('pricing: rule order, overrides and reported cost', () => {
    const p = new Pricer({ 'my-model': { input: 1, output: 2 } });
    assert.equal(p.lookup('claude-opus-5-5')?.label, 'Claude Opus 5.5');
    assert.equal(p.lookup('gpt-5.6-luna')?.label, 'GPT-5.6 Luna');
    assert.equal(p.lookup('tngtech/deepseek-r1t-chimera:free')?.label, 'Free model', 'free beats provider rules');
    assert.equal(p.lookup('Gemini 3.1 Pro (High)')?.label, 'Gemini Pro');
    assert.equal(p.lookup('totally-unknown'), null);
    assert.equal(p.lookup('vendor/my-model-v2')?.label, 'custom (my-model)');

    // Opus 5.5: $4 in, $20 out, $0.20 cache read, 1.25x/2x cache writes
    const usd = p.cost(rec({ model: 'claude-opus-5-5', input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6 }));
    assert.equal(Math.round(usd * 100) / 100, 4 + 20 + 0.2 + 5 + 8);
    assert.equal(p.cost(rec({ model: 'claude-opus-5-5', output: 1e6, costUsd: 0.5 })), 0.5, 'tool-reported cost wins');
    assert.equal(p.cost(rec({ model: 'claude-opus-5-5', output: 1e6, fast: true })), 40, 'fast mode is 2x');
});

test('mapLimit keeps order and bounds concurrency', async () => {
    let live = 0, peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
        live++; peak = Math.max(peak, live);
        await new Promise(r => setTimeout(r, n));
        live--;
        return n * 10;
    });
    assert.deepEqual(out, [50, 10, 30, 20, 40]);
    assert.ok(peak <= 2);
});

function fakeProvider(dir: string, parses: { n: number }, version = 1): Provider {
    return {
        id: 'fake', name: 'Fake', color: '#000', support: 'full', version,
        async discover() {
            const files = fs.existsSync(dir) ? fs.readdirSync(dir).map(f => path.join(dir, f)) : [];
            return { roots: fs.existsSync(dir) ? [dir] : [], files };
        },
        async parse(file) {
            parses.n++;
            const n = Number(fs.readFileSync(file, 'utf8'));
            const id = path.basename(file);
            return { records: [rec({ id, source: 'fake', ts: 1000 * n, output: n, sessionId: id })], sessions: [{ id, source: 'fake', title: 'T' + id }] };
        },
    };
}

test('scanner: caches unchanged files, re-parses changed ones, keeps history of deleted ones', async () => {
    const t = tmpDir();
    try {
        const logs = path.join(t.dir, 'logs');
        write(path.join(logs, 'a'), '1');
        write(path.join(logs, 'b'), '2');
        const parses = { n: 0 };
        const cachePath = path.join(t.dir, 'cache.json');
        const opts = () => ({ providers: [fakeProvider(logs, parses)], disabled: new Set<string>(), extraPaths: {} });

        let r = await new Scanner(cachePath).scan(opts());
        assert.equal(r.records.length, 2);
        assert.equal(parses.n, 2);

        r = await new Scanner(cachePath).scan(opts()); // fresh instance: cache comes from disk
        assert.equal(parses.n, 2, 'nothing re-parsed');

        write(path.join(logs, 'b'), '22');
        fs.rmSync(path.join(logs, 'a'));
        r = await new Scanner(cachePath).scan(opts());
        assert.equal(parses.n, 3, 'only the changed file is re-parsed');
        assert.deepEqual(r.records.map(x => x.output).sort(), [1, 22], 'deleted file a is kept from history');
        assert.match(r.status[0].notes.join(' '), /deleted/);

        // A parser version bump re-parses existing files.
        const bumped = { providers: [fakeProvider(logs, parses, 2)], disabled: new Set<string>(), extraPaths: {} };
        await new Scanner(cachePath).scan(bumped);
        assert.equal(parses.n, 4);
    } finally { t.cleanup(); }
});

test('scanner: disabled providers are reported but not counted; duplicates across files are dropped', async () => {
    const t = tmpDir();
    try {
        const logs = path.join(t.dir, 'logs');
        write(path.join(logs, 'a'), '1');
        const p = fakeProvider(logs, { n: 0 });
        const dup: Provider = { ...p, id: 'dup', async parse() { return { records: [rec({ id: 'a', source: 'dup' })], sessions: [] }; } };
        const r = await new Scanner(path.join(t.dir, 'c.json')).scan({ providers: [p, dup], disabled: new Set(), extraPaths: {} });
        assert.equal(r.records.length, 1, 'record id "a" seen twice is counted once');

        const off = await new Scanner(path.join(t.dir, 'c2.json')).scan({ providers: [p], disabled: new Set(['fake']), extraPaths: {} });
        assert.equal(off.records.length, 0);
        assert.equal(off.status[0].detected, true);
        assert.equal(off.status[0].enabled, false);
    } finally { t.cleanup(); }
});

test('payload: only sources with rows are listed and rows index them', async () => {
    const t = tmpDir();
    try {
        const logs = path.join(t.dir, 'logs');
        write(path.join(logs, 'a'), '3');
        const empty: Provider = { id: 'none', name: 'None', color: '#111', support: 'detect-only', version: 1, async discover() { return { roots: [t.dir], files: [] }; } };
        const scan = await new Scanner(path.join(t.dir, 'c.json')).scan({ providers: [empty, fakeProvider(logs, { n: 0 })], disabled: new Set(), extraPaths: {} });
        const p = buildPayload(scan, new Pricer(), {});
        assert.deepEqual(p.sources.map(s => s.id), ['fake']);
        assert.equal(p.rows[0][ROW.SRC], 0);
        assert.equal(p.status.length, 2, 'all providers stay in status');
        assert.equal(p.sessions[0].title, 'Ta');
    } finally { t.cleanup(); }
});
