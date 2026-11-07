import * as fs from 'fs';
import * as path from 'path';
import { Provider } from '../core/provider';
import { FileResult, UsageRecord } from '../core/types';
import { existingDirs, fileUriToPath, num, vscodeUserDirs } from '../core/paths';
import { readJson, tryJson } from '../core/files';

/**
 * GitHub Copilot Chat in VS Code (and VS Code-based editors).
 *
 * Sessions live in <User>/workspaceStorage/<hash>/chatSessions/<id>.json(l) and
 * <User>/globalStorage/emptyWindowChatSessions/. Newer builds write JSONL as a
 * patch log that must be replayed:
 *   {kind:0, v: <initial state>}        replace the whole state
 *   {kind:1, k: [path...], v}           set value at path
 *   {kind:2, k: [path...], v: [...], i} truncate array at path to i (if given), then append v
 *
 * Token data (verified on real logs): result.metadata.promptTokens / outputTokens are the
 * prompt size and output of the *final* model round, and request.completionTokens is
 * the total output across all rounds. Copilot does not log input for each agent round,
 * so input is a lower bound. Copilot bills per premium request, not per token, so no
 * dollar cost is estimated (costUsd = 0).
 */
export const copilotChat: Provider = {
    id: 'copilot-chat',
    name: 'GitHub Copilot',
    color: '#8957E5',
    support: 'partial',
    version: 1,

    async discover(ctx) {
        const users = existingDirs([...vscodeUserDirs(), ...ctx.extraPaths]);
        const roots: string[] = [];
        const files: string[] = [];
        const isChat = (n: string) => n.endsWith('.json') || n.endsWith('.jsonl');
        for (const u of users) {
            const ws = path.join(u, 'workspaceStorage');
            let hashes: string[] = [];
            try { hashes = await fs.promises.readdir(ws); } catch { /* none */ }
            let found = false;
            for (const h of hashes) {
                const d = path.join(ws, h, 'chatSessions');
                let names: string[] = [];
                try { names = await fs.promises.readdir(d); } catch { continue; }
                for (const n of names) { if (isChat(n)) { files.push(path.join(d, n)); found = true; } }
            }
            const empty = path.join(u, 'globalStorage', 'emptyWindowChatSessions');
            try {
                for (const n of await fs.promises.readdir(empty)) { if (isChat(n)) { files.push(path.join(empty, n)); found = true; } }
            } catch { /* none */ }
            if (found || fs.existsSync(path.join(u, 'globalStorage', 'github.copilot-chat'))) { roots.push(u); }
        }
        return {
            roots,
            files,
            notes: [
                'Copilot logs the prompt size of the final step of each request plus total output, so input tokens are a lower bound for agent-mode requests.',
                'Copilot is billed per premium request, not per token, so no dollar cost is estimated. Check github.com/settings/billing for premium request usage.',
            ],
        };
    },

    parse: parseCopilotSession,
};

/** Apply one JSONL patch operation to the state object. */
export function applyPatch(root: any, op: any): any {
    if (op.kind === 0) { return op.v ?? {}; }
    if (!Array.isArray(op.k) || !op.k.length) { return root; }
    let o = root;
    for (let i = 0; i < op.k.length - 1; i++) {
        const k = op.k[i];
        if (o[k] === null || typeof o[k] !== 'object') { o[k] = typeof op.k[i + 1] === 'number' ? [] : {}; }
        o = o[k];
    }
    const last = op.k[op.k.length - 1];
    if (op.kind === 1) {
        o[last] = op.v;
    } else if (op.kind === 2) {
        if (!Array.isArray(o[last])) { o[last] = []; }
        if (typeof op.i === 'number') { o[last].length = Math.min(o[last].length, op.i); }
        if (Array.isArray(op.v)) { o[last].push(...op.v); } else if (op.v !== undefined) { o[last].push(op.v); }
    }
    return root;
}

export async function parseCopilotSession(file: string): Promise<FileResult> {
    const text = await fs.promises.readFile(file, 'utf8');
    let state: any;
    if (file.endsWith('.jsonl')) {
        state = {};
        for (const line of text.split('\n')) {
            const op = line && tryJson(line);
            if (op && typeof op.kind === 'number') { state = applyPatch(state, op); }
        }
    } else {
        state = tryJson(text);
    }
    if (!state || typeof state !== 'object') { return { records: [], sessions: [], unreadable: true }; }

    const sessionId: string = state.sessionId || path.basename(file).replace(/\.jsonl?$/, '');
    const project = await workspaceFolder(file);
    const records: UsageRecord[] = [];
    let firstPrompt: string | undefined;
    for (const r of Array.isArray(state.requests) ? state.requests : []) {
        const ts = num(r?.timestamp);
        if (!ts) { continue; }
        firstPrompt ??= typeof r.message?.text === 'string' ? r.message.text : undefined;
        const meta = r.result?.metadata || {};
        const prompt = num(meta.promptTokens ?? r.promptTokens);
        const output = Math.max(num(r.completionTokens), num(meta.outputTokens));
        const model = String(meta.resolvedModel || r.modelId || 'copilot').replace(/^copilot\//, '');
        records.push({
            id: `cp:${sessionId}:${r.requestId || ts}`,
            source: copilotChat.id,
            ts,
            model,
            sessionId,
            project,
            input: prompt,
            cacheRead: 0,
            cacheWrite: 0,
            cacheWrite1h: 0,
            output,
            reasoning: 0,
            costUsd: 0,
        });
    }
    const title = state.customTitle || (firstPrompt ? firstPrompt.trim().replace(/\s+/g, ' ').slice(0, 90) : undefined);
    return { records, sessions: [{ id: sessionId, source: copilotChat.id, title, project }] };
}

const workspaceCache = new Map<string, string>();
/** <User>/workspaceStorage/<hash>/workspace.json -> folder path. */
async function workspaceFolder(sessionFile: string): Promise<string> {
    const dir = path.dirname(path.dirname(sessionFile));
    const hit = workspaceCache.get(dir);
    if (hit !== undefined) { return hit; }
    const w = await readJson<any>(path.join(dir, 'workspace.json'));
    const uri = w?.folder || w?.workspace || '';
    const p = uri ? fileUriToPath(String(uri)) : '';
    workspaceCache.set(dir, p);
    return p;
}
