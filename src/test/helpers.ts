import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Fresh temp dir per test; removed by the returned cleanup. */
export function tmpDir(): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-test-'));
    return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function write(file: string, content: string | Buffer): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}

export const jsonl = (...objs: unknown[]) => objs.map(o => JSON.stringify(o)).join('\n') + '\n';

/** Minimal protobuf encoder for building Antigravity fixtures. */
export type Pb = [number, number | string | Uint8Array | Pb][];
function varint(n: number): number[] {
    const out: number[] = [];
    do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) { b |= 0x80; } out.push(b); } while (n > 0);
    return out;
}
export function pb(fields: Pb): Uint8Array {
    const out: number[] = [];
    for (const [f, v] of fields) {
        if (typeof v === 'number') { out.push(...varint(f * 8), ...varint(v)); continue; }
        const bytes = typeof v === 'string' ? Buffer.from(v, 'utf8') : v instanceof Uint8Array ? v : pb(v);
        out.push(...varint(f * 8 + 2), ...varint(bytes.length), ...bytes);
    }
    return Uint8Array.from(out);
}
