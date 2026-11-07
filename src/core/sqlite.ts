import * as fs from 'fs';
import * as path from 'path';
import type { Database, SqlJsStatic } from 'sql.js';

/**
 * SQLite via sql.js (WebAssembly), so no native module has to match the user's
 * VS Code/Electron version. Databases are read into memory and opened read-only
 * in practice (we never write back), so the tool that owns the file is unaffected.
 */
let sqlPromise: Promise<SqlJsStatic> | undefined;

function sql(): Promise<SqlJsStatic> {
    if (!sqlPromise) {
        const initSqlJs = require('sql.js') as (cfg: unknown) => Promise<SqlJsStatic>;
        const dist = path.dirname(require.resolve('sql.js'));
        sqlPromise = initSqlJs({ locateFile: (f: string) => path.join(dist, f) });
    }
    return sqlPromise;
}

export async function withDb<T>(file: string, fn: (db: Database) => T): Promise<T> {
    const SQL = await sql();
    const db = new SQL.Database(await fs.promises.readFile(file));
    try { return fn(db); } finally { db.close(); }
}

/** Rows of a query as plain objects. */
export function rows(db: Database, query: string): Record<string, unknown>[] {
    const res = db.exec(query);
    if (!res.length) { return []; }
    const { columns, values } = res[0];
    return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

export function tableNames(db: Database): string[] {
    return rows(db, "select name from sqlite_master where type='table'").map(r => String(r.name));
}
