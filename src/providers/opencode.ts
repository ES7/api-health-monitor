import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, SessionInfo, UsageRecord } from '../core/types';
import { existingDirs, num, toMs, walk, xdgDataDirs } from '../core/paths';
import { readJson, tryJson } from '../core/files';
import { rows, tableNames, withDb } from '../core/sqlite';

/**
 * OpenCode (sst/opencode).
 *
 * Data dir: $OPENCODE_DATA_DIR or <XDG data>/opencode.
 *  - v1.2+: opencode.db (SQLite). Messages are rows whose JSON `data` holds the message.
 *  - older: storage/message/<sessionID>/<messageID>.json, one JSON message per file.
 * Assistant message: { id, sessionID, role: "assistant", time: { created }, modelID,
 *   providerID, cost, tokens: { input, output, reasoning, cache: { read, write } }, path: { cwd } }.
 * `cost` is computed by OpenCode and used as-is when non-zero.
 * Session titles: storage/session/**\/<id>.json or the `session` table.
 */
export const opencode: Provider = {
    id: 'opencode',
    name: 'OpenCode',
    color: '#F0B72F',
    support: 'full',
    version: 1,

    async discover(ctx) {
        const roots = existingDirs([process.env.OPENCODE_DATA_DIR, ...xdgDataDirs().map(d => path.join(d, 'opencode')), ...ctx.extraPaths]);
        const files: string[] = [];
        for (const r of roots) {
            for (const n of ['opencode.db', 'opencode-stable.db']) {
                const f = path.join(r, n);
                if (fs.existsSync(f)) { files.push(f); }
            }
            const msgDir = path.join(r, 'storage', 'message');
            if (fs.existsSync(msgDir)) {
                // One cache entry per session *folder*: a folder's mtime changes whenever a
                // message file is added, so the cache invalidates correctly.
                for (const s of await fs.promises.readdir(msgDir).catch(() => [] as string[])) {
                    files.push(path.join(msgDir, s));
                }
            }
        }
        return { roots, files };
    },

    async parse(file) {
        return file.endsWith('.db') ? parseOpencodeDb(file) : parseOpencodeSessionDir(file);
    },

    async enrich(_ctx, roots, sessions, records) {
        for (const r of roots) {
            const dir = path.join(r, 'storage', 'session');
            if (!fs.existsSync(dir)) { continue; }
            for (const f of await walk(dir, n => n.endsWith('.json'), 3)) {
                const s = await readJson<any>(f);
                const info = s?.id && sessions.get(`${opencode.id}:${s.id}`);
                if (!info) { continue; }
                if (typeof s.title === 'string') { info.title = s.title; }
                if (typeof s.directory === 'string') { info.project = s.directory; }
            }
        }
        for (const rec of records) {
            if (!rec.project) { rec.project = sessions.get(`${opencode.id}:${rec.sessionId}`)?.project || ''; }
        }
    },
};

export function opencodeRecord(m: any): UsageRecord | undefined {
    if (!m || m.role !== 'assistant' || !m.tokens) { return undefined; }
    const ts = toMs(m.time?.created ?? m.time?.completed);
    if (!isFinite(ts)) { return undefined; }
    const t = m.tokens;
    const cost = num(m.cost);
    return {
        id: `oc:${m.id || `${m.sessionID}:${ts}`}`,
        source: opencode.id,
        ts,
        model: m.modelID || m.model?.modelID || 'unknown',
        sessionId: m.sessionID || '',
        project: m.path?.cwd || m.path?.root || '',
        input: num(t.input),
        cacheRead: num(t.cache?.read),
        cacheWrite: num(t.cache?.write),
        cacheWrite1h: 0,
        output: num(t.output),
        reasoning: num(t.reasoning),
        costUsd: cost > 0 ? cost : undefined,
    };
}

export async function parseOpencodeSessionDir(dir: string): Promise<FileResult> {
    const records: UsageRecord[] = [];
    for (const n of await fs.promises.readdir(dir)) {
        if (!n.endsWith('.json')) { continue; }
        const r = opencodeRecord(await readJson(path.join(dir, n)));
        if (r) { records.push(r); }
    }
    const id = path.basename(dir);
    return { records, sessions: [{ id, source: opencode.id, project: records[0]?.project }] };
}

export async function parseOpencodeDb(file: string): Promise<FileResult> {
    return withDb(file, db => {
        const tables = tableNames(db);
        const records: UsageRecord[] = [];
        const sessions = new Map<string, SessionInfo>();
        if (tables.includes('message')) {
            for (const row of rows(db, 'select * from message')) {
                const raw = typeof row.data === 'string' ? tryJson(row.data) : undefined;
                const m = raw && { ...raw, id: raw.id ?? row.id, sessionID: raw.sessionID ?? row.session_id };
                const r = opencodeRecord(m);
                if (r) { records.push(r); }
            }
        }
        if (tables.includes('session')) {
            for (const row of rows(db, 'select * from session')) {
                const data = typeof row.data === 'string' ? tryJson(row.data) : undefined;
                const id = String(row.id ?? data?.id ?? '');
                if (!id) { continue; }
                sessions.set(id, { id, source: opencode.id, title: String(row.title ?? data?.title ?? '') || undefined, project: String(row.directory ?? data?.directory ?? '') || undefined });
            }
        }
        for (const r of records) {
            if (!sessions.has(r.sessionId)) { sessions.set(r.sessionId, { id: r.sessionId, source: opencode.id, project: r.project }); }
        }
        return { records, sessions: [...sessions.values()], unreadable: !tables.includes('message') };
    });
}
