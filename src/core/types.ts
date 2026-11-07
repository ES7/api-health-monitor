/** One model request (one API response) recovered from a local log. */
export interface UsageRecord {
    /** Unique id, used to de-duplicate the same response seen in more than one file. */
    id: string;
    /** Provider id, e.g. "claude-code". */
    source: string;
    /** Epoch milliseconds. */
    ts: number;
    model: string;
    sessionId: string;
    project: string;
    /** Uncached input tokens. */
    input: number;
    cacheRead: number;
    /** Cache writes (5-minute TTL for Anthropic models). */
    cacheWrite: number;
    /** Cache writes with a 1-hour TTL (Anthropic only, priced at 2x input). */
    cacheWrite1h: number;
    /** Output tokens, including reasoning/thinking tokens. */
    output: number;
    /** Reasoning/thinking part of output (informational). */
    reasoning: number;
    /** Cost in USD as reported by the tool itself; when absent it is estimated from prices. */
    costUsd?: number;
    /** Anthropic fast mode (billed at 2x). */
    fast?: boolean;
}

export interface SessionInfo {
    id: string;
    source: string;
    title?: string;
    project?: string;
}

export interface RateLimitWindow {
    usedPercent: number;
    windowMinutes: number;
    /** Epoch ms. */
    resetsAt: number;
}

export interface RateLimitInfo {
    source: string;
    observedAt: number;
    plan?: string;
    primary?: RateLimitWindow;
    secondary?: RateLimitWindow;
}

/** Result of parsing one file. Cached by path + mtime + size + parser version. */
export interface FileResult {
    records: UsageRecord[];
    sessions: SessionInfo[];
    rateLimit?: RateLimitInfo;
    /** The file exists but could not be read (encrypted, locked, unknown format). */
    unreadable?: boolean;
}

export type SupportLevel =
    /** Tokens are read from local logs. */
    | 'full'
    /** Requests are counted but the tool only logs some token fields (see the provider's notes). */
    | 'partial'
    /** The tool is installed but does not keep usage on disk (or the format is not supported yet). */
    | 'detect-only';

/** What the scanner reports about each provider. */
export interface ProviderStatus {
    id: string;
    name: string;
    color: string;
    support: SupportLevel;
    /** True when any of the provider's data folders exist. */
    detected: boolean;
    enabled: boolean;
    roots: string[];
    files: number;
    unreadableFiles: number;
    records: number;
    notes: string[];
}
