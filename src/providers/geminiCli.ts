import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, UsageRecord } from '../core/types';
import { existingDirs, home, num, toMs, walk } from '../core/paths';
import { tryJson } from '../core/files';

/**
 * Gemini CLI. Format taken from gemini-cli's ChatRecordingService.
 *
 * $GEMINI_CLI_HOME/tmp/<project>/chats/session-<time>-<id>.jsonl (fallback ~/.gemini).
 * Subagents: chats/<parentSessionId>/<id>.jsonl. Legacy builds wrote a single .json document.
 * JSONL lines:
 *   first line   { sessionId, projectHash, startTime, lastUpdated, directories?, summary? }
 *   message      { id, timestamp, type: "user" | "gemini" | ..., model?, tokens? }
 *   { "$set": {...} }                          metadata update (e.g. summary)
 *   { "$patch": { updates: [{ id, ...fields }] } }  message update (tokens may arrive here)
 *   { "$rewindTo": id }                        history rewind (tokens were still spent, so ignored)
 * tokens = { input, output, cached, thoughts, tool, total }. As in the Gemini API,
 * `input` includes `cached` and `thoughts` are billed as output.
 */
export const geminiCli: Provider = {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    color: '#1A73E8',
    support: 'full',
    version: 1,

    async discover(ctx) {
        const bases = existingDirs([process.env.GEMINI_CLI_HOME && path.join(process.env.GEMINI_CLI_HOME, '.gemini'), process.env.GEMINI_CLI_HOME, path.join(home(), '.gemini'), ...ctx.extraPaths]);
        const roots = existingDirs(bases.map(b => path.join(b, 'tmp')));
        const files: string[] = [];
        for (const r of roots) {
            files.push(...await walk(r, (n, full) => /(^|[\\/])chats[\\/]/.test(full) && (n.endsWith('.jsonl') || n.endsWith('.json'))));
        }
        return { roots, files };
    },

    parse: parseGeminiChat,
};

export async function parseGeminiChat(file: string): Promise<FileResult> {
    const text = await fs.promises.readFile(file, 'utf8');
    let meta: any = {};
    const messages = new Map<string, any>();

    const upsert = (m: any) => {
        if (!m || typeof m !== 'object') { return; }
        const id = m.id || `${m.timestamp}:${messages.size}`;
        messages.set(id, { ...messages.get(id), ...m });
    };

    if (file.endsWith('.jsonl')) {
        let first = true;
        for (const line of text.split('\n')) {
            const o = line && tryJson(line);
            if (!o) { continue; }
            if (first && o.sessionId && !o.type) { meta = o; first = false; continue; }
            first = false;
            if (o.$set) { meta = { ...meta, ...o.$set }; }
            else if (o.$patch) { for (const u of o.$patch.updates || []) { upsert(u); } }
            else if (o.$rewindTo !== undefined) { /* tokens were spent; keep messages */ }
            else if (o.type) { upsert(o); }
        }
    } else {
        const doc = tryJson(text);
        if (!doc) { return { records: [], sessions: [], unreadable: true }; }
        meta = doc;
        for (const m of doc.messages || []) { upsert(m); }
    }

    const sessionId: string = meta.sessionId || path.basename(file).replace(/\.jsonl?$/, '');
    // Project: recorded directories, else the per-project folder name under tmp/.
    const chatsIdx = file.split(/[\\/]/).lastIndexOf('chats');
    const projectFolder = chatsIdx > 0 ? file.split(/[\\/]/)[chatsIdx - 1] : '';
    const project: string = (Array.isArray(meta.directories) && meta.directories[0]) || projectFolder;

    const records: UsageRecord[] = [];
    let firstPrompt: string | undefined;
    for (const [id, m] of messages) {
        if (m.type === 'user' && !firstPrompt) {
            const c = m.content;
            const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.text || '').join(' ') : '';
            if (t.trim()) { firstPrompt = t.trim().replace(/\s+/g, ' ').slice(0, 90); }
        }
        const tk = m.tokens;
        if (m.type !== 'gemini' || !tk) { continue; }
        const ts = toMs(m.timestamp);
        if (!isFinite(ts)) { continue; }
        const cached = num(tk.cached);
        records.push({
            id: `gm:${sessionId}:${id}`,
            source: geminiCli.id,
            ts,
            model: m.model || 'gemini',
            sessionId,
            project,
            input: Math.max(0, num(tk.input) - cached) + num(tk.tool),
            cacheRead: cached,
            cacheWrite: 0,
            cacheWrite1h: 0,
            output: num(tk.output) + num(tk.thoughts),
            reasoning: num(tk.thoughts),
        });
    }
    const title = (typeof meta.summary === 'string' && meta.summary) || firstPrompt;
    return { records, sessions: [{ id: sessionId, source: geminiCli.id, title, project }] };
}
