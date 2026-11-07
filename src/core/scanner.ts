import * as fs from 'fs';
import * as path from 'path';
import { Provider, sessionKey } from './provider';
import { FileResult, ProviderStatus, RateLimitInfo, SessionInfo, UsageRecord } from './types';

const CACHE_FORMAT = 5;
const PARSE_CONCURRENCY = 8;

interface CacheEntry { provider: string; version: number; mtime: number; size: number; result: FileResult }
interface CacheFile { format: number; entries: Record<string, CacheEntry> }

export interface ScanOptions {
    providers: Provider[];
    /** Provider ids switched off by the user. */
    disabled: Set<string>;
    /** Extra folders per provider id. */
    extraPaths: Record<string, string[]>;
    onProgress?: (message: string) => void;
}

export interface ScanResult {
    records: UsageRecord[];
    sessions: Map<string, SessionInfo>;
    rateLimits: RateLimitInfo[];
    status: ProviderStatus[];
    scannedAt: number;
    durationMs: number;
}

/** Run async work over items with bounded concurrency, preserving input order in the output. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

/**
 * Runs every provider's discovery and parser. Parsed files are cached by
 * path + mtime + size + parser version, so a rescan only re-reads files that changed.
 * Results of files that later disappear are kept: tools prune old logs
 * (Claude Code after 30 days), but the usage history should stay.
 */
export class Scanner {
    private cache: CacheFile = { format: CACHE_FORMAT, entries: {} };
    private loaded = false;
    private running: Promise<ScanResult> | undefined;

    constructor(private readonly cachePath: string) {}

    async clear(): Promise<void> {
        this.cache = { format: CACHE_FORMAT, entries: {} };
        this.loaded = true;
        await fs.promises.rm(this.cachePath, { force: true });
    }

    /** Concurrent callers share one scan instead of starting another. */
    scan(opts: ScanOptions): Promise<ScanResult> {
        this.running ??= this.doScan(opts).finally(() => { this.running = undefined; });
        return this.running;
    }

    private async load(): Promise<void> {
        if (this.loaded) { return; }
        this.loaded = true;
        try {
            const c = JSON.parse(await fs.promises.readFile(this.cachePath, 'utf8')) as CacheFile;
            if (c.format === CACHE_FORMAT && c.entries) { this.cache = c; }
        } catch { /* first run or unreadable cache */ }
    }

    private async save(): Promise<void> {
        try {
            await fs.promises.mkdir(path.dirname(this.cachePath), { recursive: true });
            const tmp = this.cachePath + '.tmp';
            await fs.promises.writeFile(tmp, JSON.stringify(this.cache));
            await fs.promises.rename(tmp, this.cachePath);
        } catch { /* cache is an optimisation; never fail the scan */ }
    }

    private async parseCached(p: Provider, file: string, seen: Set<string>): Promise<FileResult | undefined> {
        let st: fs.Stats;
        try { st = await fs.promises.stat(file); } catch { return undefined; }
        seen.add(file);
        const hit = this.cache.entries[file];
        if (hit && hit.provider === p.id && hit.version === p.version && hit.mtime === st.mtimeMs && hit.size === st.size) {
            return hit.result;
        }
        let result: FileResult;
        try {
            result = await p.parse!(file);
        } catch {
            result = { records: [], sessions: [], unreadable: true };
        }
        this.cache.entries[file] = { provider: p.id, version: p.version, mtime: st.mtimeMs, size: st.size, result };
        return result;
    }

    private async doScan(opts: ScanOptions): Promise<ScanResult> {
        const t0 = Date.now();
        await this.load();
        const seenFiles = new Set<string>();
        const seenIds = new Set<string>();
        const records: UsageRecord[] = [];
        const sessions = new Map<string, SessionInfo>();
        const rateLimits: RateLimitInfo[] = [];
        const status: ProviderStatus[] = [];

        const add = (r: FileResult, st: ProviderStatus, into: UsageRecord[]) => {
            if (r.unreadable) { st.unreadableFiles++; }
            for (const rec of r.records) {
                if (seenIds.has(rec.id)) { continue; }
                seenIds.add(rec.id);
                into.push(rec);
                st.records++;
            }
            for (const s of r.sessions) {
                const key = sessionKey(s.source, s.id);
                const prev = sessions.get(key);
                sessions.set(key, { ...prev, ...s, title: s.title || prev?.title, project: s.project || prev?.project });
            }
            if (r.rateLimit) { rateLimits.push(r.rateLimit); }
        };

        for (const p of opts.providers) {
            const st: ProviderStatus = {
                id: p.id, name: p.name, color: p.color, support: p.support,
                detected: false, enabled: !opts.disabled.has(p.id),
                roots: [], files: 0, unreadableFiles: 0, records: 0, notes: [],
            };
            status.push(st);
            const ctx = { extraPaths: opts.extraPaths[p.id] || [] };
            let disc;
            try { disc = await p.discover(ctx); } catch (e) { st.notes.push(`Discovery failed: ${String(e)}`); continue; }
            st.roots = disc.roots;
            st.detected = disc.roots.length > 0;
            st.notes.push(...(disc.notes || []));
            st.files = disc.files.length + (disc.unreadable || 0);
            st.unreadableFiles += disc.unreadable || 0;
            if (!st.enabled || !p.parse || !disc.files.length) { continue; }

            opts.onProgress?.(`Reading ${p.name} (${disc.files.length} files)…`);
            const own: UsageRecord[] = [];
            const results = await mapLimit(disc.files, PARSE_CONCURRENCY, f => this.parseCached(p, f, seenFiles));
            for (const r of results) { if (r) { add(r, st, own); } }
            if (p.enrich) {
                try { await p.enrich(ctx, disc.roots, sessions, own); } catch { /* titles are optional */ }
            }
            records.push(...own);
        }

        // Keep history from files the tools have since deleted.
        const byId = new Map(status.map(s => [s.id, s]));
        const archived = new Map<string, number>();
        for (const [file, e] of Object.entries(this.cache.entries)) {
            if (seenFiles.has(file)) { continue; }
            const st = byId.get(e.provider);
            if (!st || !e.result.records.length) { delete this.cache.entries[file]; continue; }
            if (!st.enabled) { continue; }
            add({ ...e.result, rateLimit: undefined }, st, records);
            archived.set(st.id, (archived.get(st.id) || 0) + 1);
        }
        for (const [id, n] of archived) {
            const st = byId.get(id)!;
            st.detected = true;
            st.notes.push(`${n} log file(s) were deleted by ${st.name}; their usage is kept from this extension's history.`);
        }

        // Records added by archive replay may lack a project their session knows about.
        for (const r of records) {
            if (!r.project) { r.project = sessions.get(sessionKey(r.source, r.sessionId))?.project || ''; }
        }

        await this.save();
        records.sort((a, b) => a.ts - b.ts);
        rateLimits.sort((a, b) => b.observedAt - a.observedAt);
        return { records, sessions, rateLimits, status, scannedAt: Date.now(), durationMs: Date.now() - t0 };
    }
}
