import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, SessionInfo, UsageRecord } from '../core/types';
import { existingDirs, home, num, walk } from '../core/paths';
import { readLines } from '../core/files';

/**
 * Claude Code (CLI, VS Code/JetBrains extension, Claude desktop app's Code tab).
 *
 * <config>/projects/<encoded-cwd>/<session>.jsonl, subagents in <session>/subagents/*.jsonl.
 * Assistant lines carry message.usage. A response is written once per content
 * block and early blocks can hold partial streaming counts, so lines are merged
 * on message.id + requestId keeping the max of each counter.
 */
export const claudeCode: Provider = {
    id: 'claude-code',
    name: 'Claude Code',
    color: '#D97757',
    support: 'full',
    version: 3,

    async discover(ctx) {
        const bases = existingDirs([process.env.CLAUDE_CONFIG_DIR, path.join(home(), '.claude'), path.join(home(), '.config', 'claude'), ...ctx.extraPaths]);
        const roots = existingDirs(bases.map(b => path.join(b, 'projects')));
        const files: string[] = [];
        for (const r of roots) { files.push(...await walk(r, n => n.endsWith('.jsonl'))); }
        const notes = ['claude.ai chats (web and desktop chat) are not stored on disk, so only Claude Code usage is counted.'];
        for (const b of bases) {
            try {
                const s = JSON.parse(fs.readFileSync(path.join(b, 'settings.json'), 'utf8'));
                if (typeof s.cleanupPeriodDays !== 'number') {
                    notes.push('Claude Code deletes transcripts after 30 days by default. Usage already read is kept here; set "cleanupPeriodDays" in ~/.claude/settings.json to keep raw logs longer.');
                }
            } catch { /* no settings */ }
        }
        return { roots, files, notes };
    },

    parse: parseClaudeFile,
};

export async function parseClaudeFile(file: string): Promise<FileResult> {
    const byKey = new Map<string, UsageRecord>();
    const sessions = new Map<string, SessionInfo & { firstPrompt?: string }>();
    const session = (id: string) => {
        let s = sessions.get(id);
        if (!s) { s = { id, source: claudeCode.id }; sessions.set(id, s); }
        return s;
    };

    for await (const line of readLines(file)) {
        if (line.length < 20) { continue; }
        const isUsage = line.includes('"usage"') && line.includes('"assistant"');
        const isTitle = line.startsWith('{"type":"custom-title"') || line.startsWith('{"type":"summary"') || line.includes('"type":"ai-title"');
        const isUser = !isUsage && line.length < 20000 && line.includes('"type":"user"');
        if (!isUsage && !isTitle && !isUser) { continue; }

        let o: any;
        try { o = JSON.parse(line); } catch { continue; }

        if (isTitle) {
            const title = o.customTitle || o.aiTitle || o.title || o.summary;
            if (o.sessionId && typeof title === 'string') { session(o.sessionId).title = title; }
            continue;
        }

        if (o.type === 'user') {
            if (!o.sessionId || o.isSidechain || o.isMeta) { continue; }
            const s = session(o.sessionId);
            if (!s.project && typeof o.cwd === 'string') { s.project = o.cwd; }
            if (!s.firstPrompt) {
                const c = o.message?.content;
                const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b?.type === 'text')?.text : undefined;
                if (typeof text === 'string' && text.trim() && !text.startsWith('<')) {
                    s.firstPrompt = text.trim().replace(/\s+/g, ' ').slice(0, 90);
                }
            }
            continue;
        }

        if (o.type !== 'assistant') { continue; }
        const m = o.message;
        const u = m?.usage;
        if (!u || !m.model || m.model === '<synthetic>') { continue; }
        const ts = Date.parse(o.timestamp);
        if (!isFinite(ts)) { continue; }

        const key = `${m.id || o.uuid}:${o.requestId || ''}`;
        const cw1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
        const sid = o.sessionId || path.basename(file, '.jsonl');
        const rec: UsageRecord = {
            id: 'cc:' + key,
            source: claudeCode.id,
            ts,
            model: m.model,
            sessionId: sid,
            project: o.cwd || '',
            input: num(u.input_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheWrite: Math.max(0, num(u.cache_creation_input_tokens) - cw1h),
            cacheWrite1h: cw1h,
            output: num(u.output_tokens),
            reasoning: num(u.output_tokens_details?.thinking_tokens),
            fast: u.speed === 'fast',
        };
        const prev = byKey.get(key);
        if (prev) {
            rec.input = Math.max(prev.input, rec.input);
            rec.cacheRead = Math.max(prev.cacheRead, rec.cacheRead);
            // Merge the cache-write *total*, then split it: an early line may lack the
            // 1-hour breakdown, so maxing each part separately would double count.
            const total = Math.max(prev.cacheWrite + prev.cacheWrite1h, rec.cacheWrite + rec.cacheWrite1h);
            rec.cacheWrite1h = Math.min(total, Math.max(prev.cacheWrite1h, rec.cacheWrite1h));
            rec.cacheWrite = total - rec.cacheWrite1h;
            rec.output = Math.max(prev.output, rec.output);
            rec.reasoning = Math.max(prev.reasoning, rec.reasoning);
            rec.ts = Math.min(prev.ts, rec.ts);
        }
        byKey.set(key, rec);
        const s = session(sid);
        if (!s.project && rec.project) { s.project = rec.project; }
    }

    const out: SessionInfo[] = [];
    for (const s of sessions.values()) {
        out.push({ id: s.id, source: s.source, project: s.project, title: s.title || s.firstPrompt });
    }
    return { records: [...byKey.values()], sessions: out };
}
