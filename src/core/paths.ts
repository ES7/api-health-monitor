import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Cross-platform locations where AI tools keep their data.
 * Every function returns candidates; callers filter with existingDirs().
 */

export const home = (): string => os.homedir();

export function expandHome(p: string): string {
    if (p === '~') { return home(); }
    if (p.startsWith('~/') || p.startsWith('~\\')) { return path.join(home(), p.slice(2)); }
    return p;
}

/** Per-user application config dir: %APPDATA%, ~/Library/Application Support, or $XDG_CONFIG_HOME. */
export function appConfigDir(): string {
    if (process.platform === 'win32') { return process.env.APPDATA || path.join(home(), 'AppData', 'Roaming'); }
    if (process.platform === 'darwin') { return path.join(home(), 'Library', 'Application Support'); }
    return process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
}

/** XDG data home. CLI tools written for Unix use this on Windows too (~/.local/share). */
export function xdgDataDirs(): string[] {
    const out = [process.env.XDG_DATA_HOME, path.join(home(), '.local', 'share')];
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) { out.push(process.env.LOCALAPPDATA); }
    if (process.platform === 'darwin') { out.push(path.join(home(), 'Library', 'Application Support')); }
    return out.filter((x): x is string => !!x);
}

/** VS Code and its forks keep extension data in <appConfig>/<Product>/User. */
export const VSCODE_PRODUCTS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf', 'Antigravity', 'Trae', 'Kiro', 'Positron', 'Void'];

/** All VS Code-like "User" folders on this machine, including remote-server installs. */
export function vscodeUserDirs(): string[] {
    const base = appConfigDir();
    const dirs = VSCODE_PRODUCTS.map(p => path.join(base, p, 'User'));
    for (const server of ['.vscode-server', '.vscode-server-insiders', '.cursor-server', '.windsurf-server']) {
        dirs.push(path.join(home(), server, 'data', 'User'));
    }
    return existingDirs(dirs);
}

/** Resolve, de-duplicate (case-insensitively on Windows) and keep only existing directories. */
export function existingDirs(dirs: (string | undefined)[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const d of dirs) {
        if (!d) { continue; }
        const full = path.resolve(expandHome(d));
        const key = process.platform === 'win32' ? full.toLowerCase() : full;
        if (seen.has(key)) { continue; }
        try {
            if (fs.statSync(full).isDirectory()) { seen.add(key); out.push(full); }
        } catch { /* missing */ }
    }
    return out;
}

export function isFile(p: string): boolean {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Recursively list files under dir whose name matches. Never follows symlinks. */
export async function walk(dir: string, match: (name: string, full: string) => boolean, maxDepth = 8): Promise<string[]> {
    const out: string[] = [];
    async function rec(d: string, depth: number) {
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (depth < maxDepth) { await rec(full, depth + 1); }
            } else if (e.isFile() && match(e.name, full)) {
                out.push(full);
            }
        }
    }
    await rec(dir, 0);
    return out;
}

/** Safe number: anything that is not a finite number becomes 0. */
export function num(v: unknown): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** Parse a timestamp given as epoch ms, epoch seconds or an ISO string. Returns NaN when invalid. */
export function toMs(v: unknown): number {
    if (typeof v === 'number' && isFinite(v)) { return v < 1e12 ? v * 1000 : v; }
    if (typeof v === 'string') { return Date.parse(v); }
    return NaN;
}

/** file:///c%3A/Users/x -> c:/Users/x */
export function fileUriToPath(uri: string): string {
    if (!uri.startsWith('file:')) { return uri; }
    let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
    if (/^\/[a-zA-Z]:/.test(p)) { p = p.slice(1); }
    return p;
}
