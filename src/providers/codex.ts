import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, RateLimitInfo, RateLimitWindow, UsageRecord } from '../core/types';
import { existingDirs, home, num, walk } from '../core/paths';
import { readText, tryJson } from '../core/files';

/**
 * OpenAI Codex (CLI, IDE extension, Codex desktop app).
 *
 * <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, zstd-compressed (.jsonl.zst) in newer builds.
 * Token usage comes from deltas of the running `total_token_usage` in
 * `event_msg/token_count` events, which cover the whole session in every build.
 * Newer builds also write per-response `token_usage_record` lines, but a session
 * resumed in a newer build only has them for the later part, so they are the fallback.
 * OpenAI semantics: input_tokens includes cached tokens; output_tokens includes reasoning.
 */
export const codex: Provider = {
    id: 'codex',
    name: 'Codex',
    color: '#10A37F',
    support: 'full',
    version: 2,

    async discover(ctx) {
        const roots = existingDirs([process.env.CODEX_HOME, path.join(home(), '.codex'), ...ctx.extraPaths]);
        const files: string[] = [];
        for (const r of roots) {
            for (const sub of ['sessions', 'archived_sessions']) {
                const d = path.join(r, sub);
                if (fs.existsSync(d)) { files.push(...await walk(d, n => n.endsWith('.jsonl') || n.endsWith('.jsonl.zst'))); }
            }
        }
        return { roots, files };
    },

    parse: parseCodexFile,

    async enrich(_ctx, roots, sessions) {
        for (const r of roots) {
            let text: string;
            try { text = await fs.promises.readFile(path.join(r, 'session_index.jsonl'), 'utf8'); } catch { continue; }
            for (const line of text.split('\n')) {
                const o = tryJson(line);
                const s = o?.id && sessions.get(`${codex.id}:${o.id}`);
                if (s && o.thread_name) { s.title = o.thread_name; }
            }
        }
    },
};

function window(w: any): RateLimitWindow | undefined {
    if (!w || typeof w.used_percent !== 'number') { return undefined; }
    return { usedPercent: w.used_percent, windowMinutes: num(w.window_minutes), resetsAt: num(w.resets_at) * 1000 };
}

export async function parseCodexFile(file: string): Promise<FileResult> {
    const lines = (await readText(file)).split('\n');
    let sessionId = path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
    let project = '';
    let model = 'gpt-5';
    const fromRecords: UsageRecord[] = [];
    const fromTotals: UsageRecord[] = [];
    let prevTotal: any;
    let rateLimit: RateLimitInfo | undefined;
    let n = 0;

    const mk = (ts: number, u: any, idPart: string): UsageRecord => {
        const cached = num(u.cached_input_tokens);
        return {
            id: `cx:${sessionId}:${idPart}`,
            source: codex.id,
            ts,
            model,
            sessionId,
            project,
            input: Math.max(0, num(u.input_tokens) - cached),
            cacheRead: cached,
            cacheWrite: num(u.cache_write_input_tokens),
            cacheWrite1h: 0,
            output: num(u.output_tokens),
            reasoning: num(u.reasoning_output_tokens),
        };
    };

    for (const line of lines) {
        if (!line || !(line.includes('"session_meta"') || line.includes('"turn_context"') || line.includes('"token_usage_record"') || line.includes('"token_count"'))) { continue; }
        const o = tryJson(line);
        if (!o) { continue; }
        const p = o.payload || {};
        const ts = Date.parse(o.timestamp);

        if (o.type === 'session_meta') {
            if (p.id) { sessionId = p.id; }
            if (p.cwd) { project = p.cwd; }
            if (p.model) { model = p.model; }
        } else if (o.type === 'turn_context') {
            if (p.model) { model = p.model; }
            if (p.cwd) { project = p.cwd; }
        } else if (o.type === 'token_usage_record' && p.usage && isFinite(ts)) {
            fromRecords.push(mk(ts, p.usage, p.response_id || String(n++)));
        } else if (o.type === 'event_msg' && p.type === 'token_count') {
            const t = p.info?.total_token_usage;
            if (t && isFinite(ts)) {
                // A lower total means the counter restarted; count from zero again.
                if (prevTotal && num(t.total_tokens) < num(prevTotal.total_tokens)) { prevTotal = undefined; }
                if (!prevTotal || num(t.total_tokens) > num(prevTotal.total_tokens)) {
                    const d = prevTotal
                        ? {
                            input_tokens: num(t.input_tokens) - num(prevTotal.input_tokens),
                            cached_input_tokens: num(t.cached_input_tokens) - num(prevTotal.cached_input_tokens),
                            cache_write_input_tokens: num(t.cache_write_input_tokens) - num(prevTotal.cache_write_input_tokens),
                            output_tokens: num(t.output_tokens) - num(prevTotal.output_tokens),
                            reasoning_output_tokens: num(t.reasoning_output_tokens) - num(prevTotal.reasoning_output_tokens),
                        }
                        : t;
                    fromTotals.push(mk(ts, d, 'tc' + String(n++)));
                    prevTotal = t;
                }
            }
            const rl = p.rate_limits;
            if (rl && isFinite(ts)) {
                rateLimit = { source: codex.id, observedAt: ts, plan: rl.plan_type || undefined, primary: window(rl.primary), secondary: window(rl.secondary) };
            }
        }
    }

    return {
        records: fromTotals.length ? fromTotals : fromRecords,
        sessions: [{ id: sessionId, source: codex.id, project }],
        rateLimit,
    };
}
