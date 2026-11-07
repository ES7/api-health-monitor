import { FileResult, SessionInfo, SupportLevel, UsageRecord } from './types';

export interface ProviderContext {
    /** Extra data folders configured by the user for this provider (aiUsage.extraPaths). */
    extraPaths: string[];
}

export interface Discovery {
    /** Existing data folders. Empty = the tool is not installed / never used here. */
    roots: string[];
    /** Files to parse (each is cached independently). */
    files: string[];
    /** Files that exist but can never be read (e.g. encrypted). */
    unreadable?: number;
    notes?: string[];
}

/**
 * One AI coding tool. To support a new tool, implement this interface in
 * src/providers/<tool>.ts and add it to the registry in src/providers/index.ts.
 */
export interface Provider {
    /** Stable id, used in settings and the cache. */
    readonly id: string;
    readonly name: string;
    /** Brand-ish colour for charts. */
    readonly color: string;
    readonly support: SupportLevel;
    /** Bump when the parser changes so cached results for this provider are re-parsed. */
    readonly version: number;
    /** Find data folders and the files to parse. Must be fast and must not throw. */
    discover(ctx: ProviderContext): Promise<Discovery>;
    /** Parse one file. May throw; the scanner marks the file unreadable. */
    parse?(file: string): Promise<FileResult>;
    /**
     * Optional pass after all files are parsed: fill in session titles/projects from
     * index files, attribute records to projects, etc.
     */
    enrich?(ctx: ProviderContext, roots: string[], sessions: Map<string, SessionInfo>, records: UsageRecord[]): Promise<void>;
}

export const sessionKey = (source: string, id: string) => `${source}:${id}`;
