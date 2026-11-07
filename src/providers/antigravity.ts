import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, UsageRecord } from '../core/types';
import { existingDirs, fileUriToPath, home } from '../core/paths';
import { rows, withDb } from '../core/sqlite';
import { getInt, getIntMap, getString } from '../core/protobuf';
import { tryJson } from '../core/files';

/**
 * Google Antigravity (IDE, IDE extension and CLI).
 *
 * <data>/conversations/<id>.db is SQLite; table gen_metadata holds one protobuf
 * row per model generation (field numbers verified against real data):
 *   1.4      usage { 2: input (uncached), 3: output incl. thinking, 5: cache read, 9: thinking }
 *   1.9.4.1  generation time (unix seconds)
 *   1.21     model display name, e.g. "Gemini 3.1 Pro (High)"; 1.19 is an internal fallback name
 * Older builds stored conversations as encrypted .pb files, which cannot be read.
 * Titles and workspaces come from <data>/conversation_summaries.db.
 */
export const antigravity: Provider = {
    id: 'antigravity',
    name: 'Antigravity',
    color: '#4285F4',
    support: 'full',
    version: 2,

    async discover(ctx) {
        const g = path.join(home(), '.gemini');
        const roots = existingDirs([path.join(g, 'antigravity'), path.join(g, 'antigravity-ide'), path.join(g, 'antigravity-cli'), ...ctx.extraPaths]);
        const files: string[] = [];
        let encrypted = 0;
        for (const r of roots) {
            let names: string[] = [];
            try { names = await fs.promises.readdir(path.join(r, 'conversations')); } catch { continue; }
            for (const n of names) {
                if (n.endsWith('.db')) { files.push(path.join(r, 'conversations', n)); }
                else if (n.endsWith('.pb')) { encrypted++; }
            }
        }
        const notes = encrypted
            ? [`${encrypted} older conversation(s) are stored encrypted (.pb) by Antigravity, so their tokens cannot be counted. Newer conversations (.db) are counted.`]
            : [];
        return { roots, files, unreadable: encrypted, notes };
    },

    parse: parseAntigravityDb,

    async enrich(_ctx, roots, sessions, records) {
        for (const r of roots) {
            const f = path.join(r, 'conversation_summaries.db');
            if (!fs.existsSync(f)) { continue; }
            try {
                await withDb(f, db => {
                    for (const row of rows(db, 'select conversation_id, title, preview, workspace_uris from conversation_summaries')) {
                        const s = sessions.get(`${antigravity.id}:${row.conversation_id}`);
                        if (!s) { continue; }
                        s.title = String(row.title || row.preview || '') || s.title;
                        const uri = (tryJson(String(row.workspace_uris || '[]')) || [])[0];
                        if (uri) { s.project = fileUriToPath(String(uri)); }
                    }
                });
            } catch { /* locked or different schema */ }
        }
        for (const rec of records) {
            if (!rec.project) { rec.project = sessions.get(`${antigravity.id}:${rec.sessionId}`)?.project || ''; }
        }
    },
};

export async function parseAntigravityDb(file: string): Promise<FileResult> {
    const sessionId = path.basename(file, '.db');
    let mtime = Date.now();
    try { mtime = (await fs.promises.stat(file)).mtimeMs; } catch { /* ignore */ }
    const records: UsageRecord[] = [];
    await withDb(file, db => {
        let lastTs = 0;
        for (const row of rows(db, 'select idx, data from gen_metadata order by idx')) {
            const data = row.data;
            if (!(data instanceof Uint8Array)) { continue; }
            const usage = getIntMap(data, [1, 4]);
            if (!usage) { continue; }
            const input = usage[2] || 0, output = usage[3] || 0, cacheRead = usage[5] || 0;
            if (!input && !output && !cacheRead) { continue; }
            const secs = getInt(data, [1, 9, 4, 1]);
            const ts = secs && secs > 1e9 ? secs * 1000 : (lastTs || mtime);
            lastTs = ts;
            records.push({
                id: `ag:${sessionId}:${row.idx}`,
                source: antigravity.id,
                ts,
                model: getString(data, [1, 21]) || getString(data, [21]) || getString(data, [1, 19]) || 'gemini',
                sessionId,
                project: '',
                input,
                cacheRead,
                cacheWrite: 0,
                cacheWrite1h: 0,
                output,
                reasoning: usage[9] || 0,
            });
        }
    });
    return { records, sessions: [{ id: sessionId, source: antigravity.id }] };
}
