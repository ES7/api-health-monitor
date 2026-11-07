import * as vscode from 'vscode';
import * as path from 'path';
import { Scanner, ScanResult } from './core/scanner';
import { Pricer } from './core/pricing';
import { buildPayload, DashboardPayload, projectLabel, ROW } from './core/payload';
import { PROVIDERS } from './providers';

const SEEN_AGENTS_KEY = 'aiUsage.seenAgents';

let scanner: Scanner;
let latest: DashboardPayload | undefined;
let statusItem: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;
let extCtx: vscode.ExtensionContext;
const views = new Set<vscode.Webview>();
const log = vscode.window.createOutputChannel('Agent Ledger', { log: true });

const cfg = () => vscode.workspace.getConfiguration('aiUsage');
const broadcast = (msg: unknown) => { for (const v of views) { void v.postMessage(msg); } };

async function rescan(): Promise<void> {
    broadcast({ type: 'scanning', message: 'Reading local logs…' });
    statusItem.text = '$(sync~spin) AI usage';
    try {
        const c = cfg();
        const scan = await scanner.scan({
            providers: PROVIDERS,
            disabled: new Set(c.get<string[]>('disabledAgents', [])),
            extraPaths: c.get<Record<string, string[]>>('extraPaths', {}),
            onProgress: m => broadcast({ type: 'scanning', message: m }),
        });
        latest = buildPayload(scan, new Pricer(c.get('pricing', {})), c.get('subscriptions', {}));
        logScan(scan);
        broadcast({ type: 'data', payload: latest });
        void announceNewAgents(scan);
    } catch (e: any) {
        log.error('Scan failed', e);
        broadcast({ type: 'error', message: String(e?.message || e) });
    } finally {
        updateStatusBar();
    }
}

function logScan(scan: ScanResult) {
    log.info(`Scan finished in ${scan.durationMs} ms: ${scan.records.length} requests`);
    for (const s of scan.status.filter(x => x.detected)) {
        log.info(`  ${s.name} [${s.support}${s.enabled ? '' : ', disabled'}]: ${s.files} files, ${s.records} requests, ${s.unreadableFiles} unreadable; ${s.roots.join(', ')}`);
    }
}

/** Tell the user once which agents were found (first run, and when a new one appears later). */
async function announceNewAgents(scan: ScanResult) {
    const seen = new Set(extCtx.globalState.get<string[]>(SEEN_AGENTS_KEY, []));
    const detected = scan.status.filter(s => s.detected);
    const fresh = detected.filter(s => !seen.has(s.id));
    if (!fresh.length) { return; }
    await extCtx.globalState.update(SEEN_AGENTS_KEY, detected.map(s => s.id));
    const counted = fresh.filter(s => s.support !== 'detect-only').map(s => s.name);
    const notCounted = fresh.filter(s => s.support === 'detect-only').map(s => s.name);
    const first = seen.size === 0;
    let msg = first ? `Agent Ledger found ${detected.length} AI coding agent${detected.length === 1 ? '' : 's'}` : 'Agent Ledger found a new AI coding agent';
    if (counted.length) { msg += `: ${counted.join(', ')}`; }
    if (notCounted.length) { msg += `${counted.length ? '. Also' : ':'} ${notCounted.join(', ')} (installed, but usage isn't stored locally)`; }
    const pick = await vscode.window.showInformationMessage(msg + '.', 'Open Dashboard');
    if (pick) { void vscode.commands.executeCommand('aiUsage.dashboard.focus'); }
}

function fmtTokens(n: number): string {
    if (n >= 1e9) { return (n / 1e9).toFixed(1) + 'B'; }
    if (n >= 1e6) { return (n / 1e6).toFixed(1) + 'M'; }
    if (n >= 1e3) { return (n / 1e3).toFixed(0) + 'k'; }
    return String(n);
}

function updateStatusBar() {
    if (!cfg().get<boolean>('statusBar', true) || !latest) { statusItem.hide(); return; }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const since = start.getTime() / 1000;
    let tok = 0, cost = 0;
    const per = new Array(latest.sources.length).fill(0);
    for (const r of latest.rows) {
        if (r[ROW.TS] < since) { continue; }
        const t = r[ROW.IN] + r[ROW.CR] + r[ROW.CW] + r[ROW.OUT];
        tok += t; cost += r[ROW.COST]; per[r[ROW.SRC]] += t;
    }
    statusItem.text = `$(pulse) ${fmtTokens(tok)} · $${cost.toFixed(2)}`;
    const md = new vscode.MarkdownString('**Agent Ledger: today**\n\n');
    latest.sources.forEach((s, i) => { if (per[i]) { md.appendMarkdown(`- ${s.name}: ${fmtTokens(per[i])} tokens\n`); } });
    if (!tok) { md.appendMarkdown('_No usage yet today._\n'); }
    md.appendMarkdown('\nCost is an API-equivalent estimate. Click to open the dashboard.');
    statusItem.tooltip = md;
    statusItem.show();
}

function nonce() {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = ''; for (let i = 0; i < 32; i++) { s += c.charAt(Math.floor(Math.random() * c.length)); }
    return s;
}

function html(webview: vscode.Webview, extUri: vscode.Uri, mode: 'sidebar' | 'panel'): string {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'dashboard.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', 'dashboard.js'));
    const n = nonce();
    // Inline style attributes are needed for data-driven bar widths and colours.
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>Agent Ledger</title></head>
<body class="${mode}"><div id="app"><div class="loading">Reading local logs…</div></div>
<script nonce="${n}" src="${js}"></script></body></html>`;
}

function wire(webview: vscode.Webview, ctx: vscode.ExtensionContext, mode: 'sidebar' | 'panel'): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
    webview.html = html(webview, ctx.extensionUri, mode);
    views.add(webview);
    const sub = webview.onDidReceiveMessage(async (msg: any) => {
        switch (msg?.type) {
            case 'ready':
                if (latest) { void webview.postMessage({ type: 'data', payload: latest }); } else { void rescan(); }
                break;
            case 'refresh': void rescan(); break;
            case 'openPanel': void vscode.commands.executeCommand('aiUsage.openPanel'); break;
            case 'exportCsv': void vscode.commands.executeCommand('aiUsage.exportCsv'); break;
            case 'openSettings': void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:jallad.api-health-monitor'); break;
            case 'showLog': log.show(); break;
            case 'toggleAgent':
                if (typeof msg.id === 'string') {
                    const cur = new Set(cfg().get<string[]>('disabledAgents', []));
                    if (cur.has(msg.id)) { cur.delete(msg.id); } else { cur.add(msg.id); }
                    await cfg().update('disabledAgents', [...cur], vscode.ConfigurationTarget.Global);
                }
                break;
            case 'openFolder':
                if (typeof msg.path === 'string') { void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path)); }
                break;
        }
    });
    return new vscode.Disposable(() => { views.delete(webview); sub.dispose(); });
}

class SidebarProvider implements vscode.WebviewViewProvider {
    constructor(private readonly ctx: vscode.ExtensionContext) {}
    resolveWebviewView(view: vscode.WebviewView) {
        const d = wire(view.webview, this.ctx, 'sidebar');
        view.onDidDispose(() => d.dispose());
    }
}

let panel: vscode.WebviewPanel | undefined;

async function exportCsv() {
    if (!latest) { await rescan(); }
    if (!latest) { return; }
    const target = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, defaultUri: vscode.Uri.file(path.join(require('os').homedir(), 'ai-usage.csv')) });
    if (!target) { return; }
    const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const lines = ['timestamp,tool,model,session,session_title,project,input,cache_read,cache_write,output,reasoning,cost_usd'];
    for (const r of latest.rows) {
        const s = latest.sessions[r[ROW.SESS]];
        lines.push([
            new Date(r[ROW.TS] * 1000).toISOString(), q(latest.sources[r[ROW.SRC]].name), q(latest.models[r[ROW.MODEL]].name),
            q(s.id), q(s.title), q(projectLabel(latest.projects[r[ROW.PROJ]])),
            r[ROW.IN], r[ROW.CR], r[ROW.CW], r[ROW.OUT], r[ROW.REASON], r[ROW.COST],
        ].join(','));
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(lines.join('\n'), 'utf8'));
    void vscode.window.showInformationMessage(`Exported ${latest.rows.length} requests to ${target.fsPath}`);
}

function schedule() {
    if (timer) { clearInterval(timer); timer = undefined; }
    const mins = cfg().get<number>('refreshIntervalMinutes', 5);
    if (mins > 0) { timer = setInterval(() => void rescan(), mins * 60_000); }
}

export function activate(ctx: vscode.ExtensionContext) {
    extCtx = ctx;
    scanner = new Scanner(path.join(ctx.globalStorageUri.fsPath, 'usage-cache.json'));
    statusItem = vscode.window.createStatusBarItem('aiUsage.status', vscode.StatusBarAlignment.Right, 100);
    statusItem.name = 'Agent Ledger';
    statusItem.command = 'aiUsage.dashboard.focus';

    ctx.subscriptions.push(
        log,
        statusItem,
        vscode.window.registerWebviewViewProvider('aiUsage.dashboard', new SidebarProvider(ctx), { webviewOptions: { retainContextWhenHidden: true } }),
        vscode.commands.registerCommand('aiUsage.refresh', () => rescan()),
        vscode.commands.registerCommand('aiUsage.exportCsv', () => exportCsv()),
        vscode.commands.registerCommand('aiUsage.showLog', () => log.show()),
        vscode.commands.registerCommand('aiUsage.clearCache', async () => {
            const ok = await vscode.window.showWarningMessage(
                'Clear the usage cache? Usage from log files that your AI tools have already deleted will be lost.', { modal: true }, 'Clear and rescan');
            if (!ok) { return; }
            await scanner.clear();
            await rescan();
        }),
        vscode.commands.registerCommand('aiUsage.openPanel', () => {
            if (panel) { panel.reveal(); return; }
            panel = vscode.window.createWebviewPanel('aiUsage.panel', 'Agent Ledger', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
            panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
            const d = wire(panel.webview, ctx, 'panel');
            panel.onDidDispose(() => { d.dispose(); panel = undefined; });
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('aiUsage')) { return; }
            if (e.affectsConfiguration('aiUsage.refreshIntervalMinutes')) { schedule(); }
            if (e.affectsConfiguration('aiUsage.statusBar')) { updateStatusBar(); }
            void rescan();
        }),
        { dispose: () => { if (timer) { clearInterval(timer); } } },
    );

    schedule();
    void rescan();
}

export function deactivate() { /* disposables clean up */ }
