/**
 * Minimal schema-less protobuf reader. Good enough to pull known field paths out
 * of Antigravity's trajectory metadata without shipping its .proto files.
 */
export interface PbField { f: number; w: number; v: number | Uint8Array }

export function decode(buf: Uint8Array): PbField[] | undefined {
    const out: PbField[] = [];
    let i = 0;
    const varint = (): number => {
        let result = 0, mul = 1, b: number;
        do {
            if (i >= buf.length) { throw new Error('eof'); }
            b = buf[i++];
            result += (b & 0x7f) * mul;
            mul *= 128;
        } while (b & 0x80);
        return result;
    };
    try {
        while (i < buf.length) {
            const key = varint();
            const f = Math.floor(key / 8), w = key & 7;
            if (f === 0) { return undefined; }
            if (w === 0) { out.push({ f, w, v: varint() }); }
            else if (w === 1) { i += 8; if (i > buf.length) { return undefined; } }
            else if (w === 5) { i += 4; if (i > buf.length) { return undefined; } }
            else if (w === 2) {
                const len = varint();
                if (i + len > buf.length) { return undefined; }
                out.push({ f, w, v: buf.subarray(i, i + len) });
                i += len;
            } else { return undefined; }
        }
    } catch { return undefined; }
    return out;
}

/** Follow a path of field numbers through nested messages; returns all leaf values. */
export function getPath(buf: Uint8Array, path: number[]): (number | Uint8Array)[] {
    let level: (number | Uint8Array)[] = [buf];
    for (const f of path) {
        const next: (number | Uint8Array)[] = [];
        for (const v of level) {
            if (!(v instanceof Uint8Array)) { continue; }
            const fields = decode(v);
            if (!fields) { continue; }
            for (const x of fields) { if (x.f === f) { next.push(x.v); } }
        }
        level = next;
        if (!level.length) { break; }
    }
    return level;
}

export function getInt(buf: Uint8Array, path: number[]): number | undefined {
    const v = getPath(buf, path).find(x => typeof x === 'number');
    return typeof v === 'number' ? v : undefined;
}

const td = new TextDecoder('utf-8', { fatal: true });
export function getString(buf: Uint8Array, path: number[]): string | undefined {
    for (const v of getPath(buf, path)) {
        if (v instanceof Uint8Array) {
            try { return td.decode(v); } catch { /* not text */ }
        }
    }
    return undefined;
}

/** Decode a nested message at path into { fieldNumber: int } for its varint fields. */
export function getIntMap(buf: Uint8Array, path: number[]): Record<number, number> | undefined {
    const v = getPath(buf, path).find(x => x instanceof Uint8Array) as Uint8Array | undefined;
    if (!v) { return undefined; }
    const fields = decode(v);
    if (!fields) { return undefined; }
    const out: Record<number, number> = {};
    for (const x of fields) { if (typeof x.v === 'number') { out[x.f] = x.v; } }
    return out;
}
