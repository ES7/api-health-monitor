import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, UsageRecord } from '../core/types';
import { existingDirs, num, vscodeUserDirs } from '../core/paths';
import { readJson, tryJson } from '../core/files';

/**
 * Cline and its forks (Roo Code, Kilo Code) share one task format, in the
 * extension's globalStorage of every VS Code-like editor:
 *   <User>/globalStorage/<extensionId>/tasks/<taskId>/ui_messages.json
 * Every API call is a `say: "api_req_started"` message whose `text` is JSON:
 *   { tokensIn, tokensOut, cacheWrites, cacheReads, cost }
 * `cost` is what the tool computed for the configured provider, so it is used as-is.
 * The model comes from task_metadata.json (model_usage history), and the title and
 * workspace from state/taskHistory.json.
 */
export function clineFamily(opts: { id: string; name: string; color: string; extensionIds: string[] }): Provider {
    const provider: Provider = {
        id: opts.id,
        name: opts.name,
        color: opts.color,
        support: 'full',
        version: 1,

        async discover(ctx) {
            const storages = vscodeUserDirs().flatMap(u => opts.extensionIds.map(id => path.join(u, 'globalStorage', id)));
            const roots = existingDirs([...storages, ...ctx.extraPaths]);
            const files: string[] = [];
            for (const r of roots) {
                let tasks: string[] = [];
                try { tasks = await fs.promises.readdir(path.join(r, 'tasks')); } catch { continue; }
                for (const t of tasks) {
                    const f = path.join(r, 'tasks', t, 'ui_messages.json');
                    if (fs.existsSync(f)) { files.push(f); }
                }
            }
            return { roots, files };
        },

        async parse(file) {
            return parseClineTask(file, provider.id);
        },

        async enrich(_ctx, roots, sessions, records) {
            const counted = new Set(records.map(r => r.sessionId));
            for (const r of roots) {
                const hist = await readJson<any[]>(path.join(r, 'state', 'taskHistory.json'));
                if (!Array.isArray(hist)) { continue; }
                for (const h of hist) {
                    if (!h?.id) { continue; }
                    // A task whose ui_messages.json is missing or truncated still has its
                    // totals in the history index: count it as one summary record.
                    if (!counted.has(String(h.id)) && (num(h.tokensIn) || num(h.tokensOut)) && num(h.ts)) {
                        const id = String(h.id);
                        records.push({
                            id: `${provider.id}:${id}:summary`, source: provider.id, ts: num(h.ts), model: String(h.modelId || 'unknown'),
                            sessionId: id, project: '', input: num(h.tokensIn), cacheRead: num(h.cacheReads), cacheWrite: num(h.cacheWrites),
                            cacheWrite1h: 0, output: num(h.tokensOut), reasoning: 0, costUsd: typeof h.totalCost === 'number' ? h.totalCost : undefined,
                        });
                        counted.add(id);
                        if (!sessions.has(`${provider.id}:${id}`)) { sessions.set(`${provider.id}:${id}`, { id, source: provider.id }); }
                    }
                    const s = sessions.get(`${provider.id}:${h.id}`);
                    if (!s) { continue; }
                    if (typeof h.task === 'string') { s.title = h.task.trim().replace(/\s+/g, ' ').slice(0, 90); }
                    const cwd = h.cwdOnTaskInitialization || h.workspace;
                    if (typeof cwd === 'string') { s.project = cwd; }
                }
            }
            for (const rec of records) {
                if (!rec.project) { rec.project = sessions.get(`${provider.id}:${rec.sessionId}`)?.project || ''; }
            }
        },
    };
    return provider;
}

export async function parseClineTask(file: string, source: string): Promise<FileResult> {
    const dir = path.dirname(file);
    const taskId = path.basename(dir);
    const ui = await readJson<any[]>(file);
    if (!Array.isArray(ui)) { return { records: [], sessions: [], unreadable: true }; }

    // Model history: [{ ts, model_id, model_provider_id }]; pick the latest entry at or before each request.
    const meta = await readJson<any>(path.join(dir, 'task_metadata.json'));
    const models: { ts: number; model: string }[] = (Array.isArray(meta?.model_usage) ? meta.model_usage : [])
        .filter((m: any) => typeof m?.model_id === 'string')
        .map((m: any) => ({ ts: num(m.ts), model: m.model_id }))
        .sort((a: any, b: any) => a.ts - b.ts);
    const modelAt = (ts: number) => {
        let m = models[0]?.model || 'unknown';
        for (const x of models) { if (x.ts <= ts) { m = x.model; } else { break; } }
        return m;
    };

    const records: UsageRecord[] = [];
    for (const msg of ui) {
        if (msg?.say !== 'api_req_started' || typeof msg.text !== 'string') { continue; }
        const o = tryJson(msg.text);
        if (!o || (o.tokensIn === undefined && o.tokensOut === undefined)) { continue; }
        const ts = num(msg.ts);
        if (!ts) { continue; }
        records.push({
            id: `${source}:${taskId}:${ts}`,
            source,
            ts,
            model: modelAt(ts),
            sessionId: taskId,
            project: '',
            input: num(o.tokensIn),
            cacheRead: num(o.cacheReads),
            cacheWrite: num(o.cacheWrites),
            cacheWrite1h: 0,
            output: num(o.tokensOut),
            reasoning: 0,
            costUsd: typeof o.cost === 'number' ? o.cost : undefined,
        });
    }
    return { records, sessions: [{ id: taskId, source }] };
}
