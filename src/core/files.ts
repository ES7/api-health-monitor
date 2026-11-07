import * as fs from 'fs';
import * as readline from 'readline';
import * as zlib from 'zlib';

let fzstd: { decompress(b: Uint8Array): Uint8Array } | undefined;

/** zstd decompression: Node's built-in when available (Node 22.15+), else a pure-JS fallback. */
export function zstdDecompress(buf: Buffer): Buffer {
    const native = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
    if (typeof native === 'function') { return native(buf); }
    fzstd ??= require('fzstd');
    return Buffer.from(fzstd!.decompress(buf));
}

/** Read a text file, transparently decompressing .zst. */
export async function readText(file: string): Promise<string> {
    let buf: Buffer = await fs.promises.readFile(file);
    if (file.endsWith('.zst') || file.endsWith('.zstd')) { buf = zstdDecompress(buf); }
    return buf.toString('utf8');
}

/** Stream lines of a (possibly huge) text file without loading it all. */
export async function* readLines(file: string): AsyncGenerator<string> {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
        for await (const line of rl) { yield line; }
    } finally {
        rl.close();
    }
}

export async function readJson<T = unknown>(file: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T; } catch { return undefined; }
}

export function tryJson(text: string): any {
    try { return JSON.parse(text); } catch { return undefined; }
}
