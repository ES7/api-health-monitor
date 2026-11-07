// Dev-only: run every provider against this machine's real logs, outside VS Code.
// Usage: npm run compile && node out/smoke.js [cachePath]
import * as os from 'os';
import * as path from 'path';
import { Scanner } from './core/scanner';
import { Pricer } from './core/pricing';
import { buildPayload, ROW } from './core/payload';
import { PROVIDERS } from './providers';

(async () => {
    const cache = process.argv[2] || path.join(os.tmpdir(), 'ai-usage-smoke-cache.json');
    const scan = await new Scanner(cache).scan({ providers: PROVIDERS, disabled: new Set(), extraPaths: {}, onProgress: m => process.stdout.write('  ' + m + '\n') });
    const p = buildPayload(scan, new Pricer(), {});
    console.log(`\nScanned in ${scan.durationMs} ms: ${p.rows.length} requests, ${p.sessions.length} sessions\n`);
    for (const s of scan.status) {
        if (!s.detected) { continue; }
        console.log(`[${s.support.padEnd(11)}] ${s.name.padEnd(15)} files=${s.files} unreadable=${s.unreadableFiles} requests=${s.records}`);
        for (const n of s.notes) { console.log(`      - ${n}`); }
    }
    console.log('\nNot detected:', scan.status.filter(s => !s.detected).map(s => s.name).join(', '));
    console.log('');
    p.sources.forEach((s, i) => {
        let tok = 0, cost = 0, first = Infinity, last = 0;
        const sess = new Set<number>();
        for (const r of p.rows) {
            if (r[ROW.SRC] !== i) { continue; }
            tok += r[ROW.IN] + r[ROW.CR] + r[ROW.CW] + r[ROW.OUT]; cost += r[ROW.COST];
            first = Math.min(first, r[ROW.TS]); last = Math.max(last, r[ROW.TS]); sess.add(r[ROW.SESS]);
        }
        const d = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
        console.log(`${s.name.padEnd(15)} ${(tok / 1e6).toFixed(2).padStart(9)}M tokens  $${cost.toFixed(2).padStart(8)}  ${String(sess.size).padStart(4)} sessions  ${d(first)} .. ${d(last)}`);
    });
    const unpriced = p.models.filter(m => !m.priceLabel).map(m => m.name);
    console.log('\nUnpriced models:', unpriced.join(', ') || 'none');
    console.log('Rate limits:', JSON.stringify(p.rateLimits));
    console.log('Payload size:', (JSON.stringify(p).length / 1024).toFixed(0), 'KB');
})().catch(e => { console.error(e); process.exit(1); });
