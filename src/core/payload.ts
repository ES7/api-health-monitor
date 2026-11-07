import * as path from 'path';
import { Pricer } from './pricing';
import { ScanResult } from './scanner';
import { sessionKey } from './provider';
import { ProviderStatus, SupportLevel } from './types';

/**
 * Compact, JSON-friendly snapshot for the webview. Usage rows are arrays to keep
 * the message small. ROW layout (keep in sync with media/dashboard.js):
 *   [source, tsSeconds, model, session, project, input, cacheRead, cacheWrite, output, reasoning, costUsd]
 */
export const ROW = { SRC: 0, TS: 1, MODEL: 2, SESS: 3, PROJ: 4, IN: 5, CR: 6, CW: 7, OUT: 8, REASON: 9, COST: 10 } as const;

export interface PayloadSource { id: string; name: string; color: string; support: SupportLevel }

export interface DashboardPayload {
    scannedAt: number;
    durationMs: number;
    /** Sources that have usage rows, in registry order. Row[SRC] indexes this array. */
    sources: PayloadSource[];
    /** priceLabel: matched list-price rule; reported: the tool logged its own cost for this model. */
    models: { name: string; priceLabel: string | null; reported: boolean }[];
    projects: string[];
    sessions: { source: number; id: string; title: string; project: number }[];
    rows: number[][];
    rateLimits: { source: string; observedAt: number; plan?: string; primary?: unknown; secondary?: unknown }[];
    /** Every provider, detected or not, for the Agents tab. */
    status: ProviderStatus[];
    subscriptions: Record<string, number>;
}

export function projectLabel(p: string): string {
    if (!p) { return '(unknown)'; }
    const clean = p.replace(/[\\/]+$/, '');
    return path.basename(clean) || clean;
}

export function buildPayload(scan: ScanResult, pricer: Pricer, subscriptions: Record<string, number>): DashboardPayload {
    const withRows = new Set(scan.records.map(r => r.source));
    const sources: PayloadSource[] = scan.status
        .filter(s => withRows.has(s.id))
        .map(s => ({ id: s.id, name: s.name, color: s.color, support: s.support }));
    const srcIdx = new Map(sources.map((s, i) => [s.id, i]));

    const models: DashboardPayload['models'] = [];
    const modelIdx = new Map<string, number>();
    const projects: string[] = [];
    const projIdx = new Map<string, number>();
    const sessions: DashboardPayload['sessions'] = [];
    const sessIdx = new Map<string, number>();

    const proj = (p: string) => {
        let i = projIdx.get(p);
        if (i === undefined) { i = projects.length; projects.push(p); projIdx.set(p, i); }
        return i;
    };
    const model = (m: string) => {
        let i = modelIdx.get(m);
        if (i === undefined) { i = models.length; models.push({ name: m, priceLabel: pricer.lookup(m)?.label ?? null, reported: false }); modelIdx.set(m, i); }
        return i;
    };

    const rows: number[][] = [];
    for (const r of scan.records) {
        const src = srcIdx.get(r.source);
        if (src === undefined) { continue; }
        const key = sessionKey(r.source, r.sessionId);
        const info = scan.sessions.get(key);
        let si = sessIdx.get(key);
        if (si === undefined) {
            si = sessions.length;
            sessions.push({ source: src, id: r.sessionId, title: info?.title || '', project: proj(info?.project || r.project || '') });
            sessIdx.set(key, si);
        }
        const mi = model(r.model);
        if (r.costUsd !== undefined) { models[mi].reported = true; }
        rows.push([
            src,
            Math.round(r.ts / 1000),
            mi,
            si,
            proj(r.project || info?.project || ''),
            r.input,
            r.cacheRead,
            r.cacheWrite + r.cacheWrite1h,
            r.output,
            r.reasoning,
            Math.round(pricer.cost(r) * 1e6) / 1e6,
        ]);
    }

    return {
        scannedAt: scan.scannedAt,
        durationMs: scan.durationMs,
        sources,
        models,
        projects,
        sessions,
        rows,
        rateLimits: scan.rateLimits.slice(0, 1),
        status: scan.status,
        subscriptions,
    };
}
