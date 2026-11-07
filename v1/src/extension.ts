import * as vscode from 'vscode';
import { ProxyServer, InterceptedCall } from './proxy';

// ─── Types ────────────────────────────────────────────────────────────────────

type APIProvider = 'openai' | 'anthropic' | 'gemini' | 'custom';

interface APICall {
    id: string;
    provider: APIProvider;
    model: string;
    timestamp: number;
    latency: number;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    status: 'success' | 'error' | 'rate_limit';
    error?: string;
}

interface ProviderConfig {
    name: string;
    apiKey: string;
    enabled: boolean;
    customEndpoint?: string;
}

interface DashboardState {
    calls: APICall[];
    providers: Record<string, ProviderConfig>;
    totalCostToday: number;
    totalCostMonth: number;
    lastUpdated: number;
}

// ─── Cost per token ───────────────────────────────────────────────────────────

const COST_PER_1K: Record<string, { in: number; out: number }> = {
    'gpt-4o':              { in: 0.0025, out: 0.010 },
    'gpt-4o-mini':         { in: 0.00015, out: 0.0006 },
    'gpt-4-turbo':         { in: 0.010, out: 0.030 },
    'gpt-3.5-turbo':       { in: 0.0005, out: 0.0015 },
    'claude-opus-4':       { in: 0.015, out: 0.075 },
    'claude-sonnet-4':     { in: 0.003, out: 0.015 },
    'claude-haiku-4':      { in: 0.00025, out: 0.00125 },
    'gemini-1.5-pro':      { in: 0.00125, out: 0.005 },
    'gemini-1.5-flash':    { in: 0.000075, out: 0.0003 },
    'gemini-2.0-flash':    { in: 0.0001, out: 0.0004 },
    'gemini-2.5-flash':    { in: 0.00015, out: 0.0006 },
    'gemini-2.5-pro':      { in: 0.00125, out: 0.005  },
    'default':             { in: 0.001, out: 0.002 },
};

function calcCost(model: string, tokensIn: number, tokensOut: number): number {
    const key = Object.keys(COST_PER_1K).find(k => model.includes(k)) || 'default';
    const rates = COST_PER_1K[key];
    return ((tokensIn / 1000) * rates.in) + ((tokensOut / 1000) * rates.out);
}

// ─── State Manager ────────────────────────────────────────────────────────────

function getState(context: vscode.ExtensionContext): DashboardState {
    return context.globalState.get<DashboardState>('apiHealthState') || {
        calls: [], providers: {}, totalCostToday: 0,
        totalCostMonth: 0, lastUpdated: Date.now(),
    };
}

async function saveState(context: vscode.ExtensionContext, state: DashboardState) {
    if (state.calls.length > 500) state.calls = state.calls.slice(-500);
    state.lastUpdated = Date.now();
    await context.globalState.update('apiHealthState', state);
}

function getTodayCalls(calls: APICall[]): APICall[] {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return calls.filter(c => c.timestamp >= start.getTime());
}

function getMonthCalls(calls: APICall[]): APICall[] {
    const start = new Date(); start.setDate(1); start.setHours(0, 0, 0, 0);
    return calls.filter(c => c.timestamp >= start.getTime());
}

// ─── Sidebar Dashboard ────────────────────────────────────────────────────────

class APIHealthDashboardProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'apiHealthMonitor.dashboard';
    private _view?: vscode.WebviewView;
    private _context: vscode.ExtensionContext;
    private _proxyPort: number = 3001;

    constructor(context: vscode.ExtensionContext, proxyPort: number) {
        this._context = context;
        this._proxyPort = proxyPort;
    }

    public setProxyPort(port: number) {
        this._proxyPort = port;
        this.refresh();
    }

    public refresh() {
        if (this._view) {
            this._view.webview.html = this._getHtml(this._view.webview);
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'addProvider') await this._addProvider(msg.provider, msg.apiKey, msg.endpoint);
            if (msg.type === 'addManualCall') await this._addManualCall(msg.data);
            if (msg.type === 'clearData') {
                const state = getState(this._context);
                state.calls = [];
                await saveState(this._context, state);
                this.refresh();
            }
            if (msg.type === 'refresh') this.refresh();
        });
    }

    private async _addProvider(provider: string, apiKey: string, endpoint?: string) {
        const state = getState(this._context);
        state.providers[provider] = { name: provider, apiKey, enabled: true, customEndpoint: endpoint };
        await saveState(this._context, state);
        this.refresh();
        vscode.window.showInformationMessage(`✅ ${provider} API configured!`);
    }

    private async _addManualCall(data: Partial<APICall>) {
        const state = getState(this._context);
        const call: APICall = {
            id: Date.now().toString(),
            provider: (data.provider || 'custom') as APIProvider,
            model: data.model || 'unknown',
            timestamp: Date.now(),
            latency: data.latency || 0,
            tokensIn: data.tokensIn || 0,
            tokensOut: data.tokensOut || 0,
            cost: calcCost(data.model || 'default', data.tokensIn || 0, data.tokensOut || 0),
            status: data.status || 'success',
            error: data.error,
        };
        state.calls.push(call);
        await saveState(this._context, state);
        this.refresh();
    }

    public async addInterceptedCall(call: InterceptedCall) {
        const state = getState(this._context);
        const apiCall: APICall = {
            id: Date.now().toString(),
            provider: call.provider,
            model: call.model,
            timestamp: call.timestamp,
            latency: call.latency,
            tokensIn: call.tokensIn,
            tokensOut: call.tokensOut,
            cost: calcCost(call.model, call.tokensIn, call.tokensOut),
            status: call.status,
            error: call.error,
        };
        state.calls.push(apiCall);
        await saveState(this._context, state);
        this.refresh();
    }

    private _getHtml(webview: vscode.Webview): string {
        const state = getState(this._context);
        const todayCalls = getTodayCalls(state.calls);
        const monthCalls = getMonthCalls(state.calls);

        const todayCost = todayCalls.reduce((s, c) => s + c.cost, 0);
        const monthCost = monthCalls.reduce((s, c) => s + c.cost, 0);
        const todayTokensIn = todayCalls.reduce((s, c) => s + c.tokensIn, 0);
        const todayTokensOut = todayCalls.reduce((s, c) => s + c.tokensOut, 0);
        const avgLatency = todayCalls.length
            ? Math.round(todayCalls.reduce((s, c) => s + c.latency, 0) / todayCalls.length) : 0;
        const errors = todayCalls.filter(c => c.status === 'error').length;
        const rateLimits = todayCalls.filter(c => c.status === 'rate_limit').length;

        const providerBreakdown: Record<string, { calls: number; cost: number }> = {};
        for (const call of todayCalls) {
            if (!providerBreakdown[call.provider]) providerBreakdown[call.provider] = { calls: 0, cost: 0 };
            providerBreakdown[call.provider].calls++;
            providerBreakdown[call.provider].cost += call.cost;
        }

        const recentCalls = [...state.calls].reverse().slice(0, 10);

        const providerRows = Object.entries(providerBreakdown).map(([p, d]) => `
            <tr>
                <td>${this._providerIcon(p as APIProvider)} ${p}</td>
                <td>${d.calls}</td>
                <td>$${d.cost.toFixed(4)}</td>
            </tr>
        `).join('') || '<tr><td colspan="3" style="text-align:center;opacity:0.5">No calls today</td></tr>';

        const recentRows = recentCalls.map(c => `
            <tr>
                <td>${this._providerIcon(c.provider)}</td>
                <td title="${c.model}">${c.model.substring(0, 15)}${c.model.length > 15 ? '...' : ''}</td>
                <td>${c.latency}ms</td>
                <td>$${c.cost.toFixed(4)}</td>
                <td class="status-${c.status}">${c.status === 'success' ? '✅' : c.status === 'rate_limit' ? '⚠️' : '❌'}</td>
            </tr>
        `).join('') || '<tr><td colspan="5" style="text-align:center;opacity:0.5">No calls yet</td></tr>';

        const configuredProviders = Object.keys(state.providers);

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 8px; }
    h2 { font-size: 13px; margin-bottom: 8px; }
    h3 { font-size: 11px; margin-bottom: 6px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.5px; }
    .section { margin-bottom: 16px; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
    .stat-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; }
    .stat-value { font-size: 16px; font-weight: bold; color: var(--vscode-textLink-foreground); }
    .stat-label { font-size: 10px; opacity: 0.6; margin-top: 2px; }
    .proxy-box { background: var(--vscode-editor-background); border: 1px solid var(--vscode-textLink-foreground); border-radius: 4px; padding: 8px; margin-bottom: 12px; font-size: 11px; }
    .proxy-box code { background: var(--vscode-textCodeBlock-background); padding: 2px 4px; border-radius: 2px; font-size: 10px; display: block; margin-top: 4px; user-select: all; }
    .alert { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 4px; padding: 6px 8px; margin-bottom: 8px; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th { text-align: left; opacity: 0.6; padding: 3px 4px; border-bottom: 1px solid var(--vscode-panel-border); }
    td { padding: 3px 4px; border-bottom: 1px solid var(--vscode-panel-border, #ffffff10); }
    .status-success { color: #4caf50; }
    .status-error { color: #f44336; }
    .status-rate_limit { color: #ff9800; }
    input, select { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 4px 6px; font-size: 11px; margin-bottom: 6px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 5px 10px; cursor: pointer; font-size: 11px; width: 100%; margin-bottom: 4px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .chip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 2px 8px; font-size: 10px; margin-right: 4px; }
    .collapsible { cursor: pointer; user-select: none; }
    .collapsible::before { content: '▼ '; font-size: 9px; }
    .collapsible.collapsed::before { content: '▶ '; }
</style>
</head>
<body>

<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <h2>🔮 API Health Monitor</h2>
    <button class="secondary" style="width:auto;padding:3px 8px" onclick="refresh()">↻</button>
</div>

<!-- Proxy Info Box — main feature! -->
<div class="proxy-box">
    🚀 <strong>Auto Proxy Active</strong> — route your API calls through:
    <code>http://127.0.0.1:${this._proxyPort}/openai → api.openai.com</code>
    <code>http://127.0.0.1:${this._proxyPort}/anthropic → api.anthropic.com</code>
    <code>http://127.0.0.1:${this._proxyPort}/gemini → googleapis.com</code>
</div>

${errors > 0 || rateLimits > 0 ? `
<div class="alert">⚠️ ${errors > 0 ? `${errors} error(s)` : ''} ${rateLimits > 0 ? `${rateLimits} rate limit(s)` : ''} today</div>` : ''}

<div class="section">
    <h3>📊 Today</h3>
    <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">$${todayCost.toFixed(4)}</div><div class="stat-label">Cost Today</div></div>
        <div class="stat-card"><div class="stat-value">$${monthCost.toFixed(3)}</div><div class="stat-label">This Month</div></div>
        <div class="stat-card"><div class="stat-value">${todayCalls.length}</div><div class="stat-label">API Calls</div></div>
        <div class="stat-card"><div class="stat-value">${avgLatency}ms</div><div class="stat-label">Avg Latency</div></div>
        <div class="stat-card"><div class="stat-value">${(todayTokensIn + todayTokensOut).toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
        <div class="stat-card"><div class="stat-value" style="color:${errors > 0 ? '#f44336' : '#4caf50'}">${errors}</div><div class="stat-label">Errors</div></div>
    </div>
</div>

<div class="section">
    <h3>⚡ By Provider</h3>
    <table>
        <tr><th>Provider</th><th>Calls</th><th>Cost</th></tr>
        ${providerRows}
    </table>
</div>

<div class="section">
    <h3 class="collapsible" onclick="toggleSection('recent')">🕐 Recent Calls</h3>
    <div id="recent">
        <table>
            <tr><th></th><th>Model</th><th>Latency</th><th>Cost</th><th></th></tr>
            ${recentRows}
        </table>
    </div>
</div>

<div class="section">
    <h3>🔑 Configured APIs</h3>
    ${configuredProviders.length > 0
        ? configuredProviders.map(p => `<span class="chip">${this._providerIcon(p as APIProvider)} ${p}</span>`).join('')
        : '<p style="opacity:0.5;font-size:11px">No APIs configured yet</p>'
    }
</div>

<div class="section">
    <h3 class="collapsible collapsed" onclick="toggleSection('addProvider')">➕ Add / Update API Key</h3>
    <div id="addProvider" style="display:none">
        <select id="providerSelect">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="custom">Custom</option>
        </select>
        <input type="password" id="apiKeyInput" placeholder="API Key (sk-... or AIza...)" />
        <input type="text" id="endpointInput" placeholder="Custom endpoint (optional)" />
        <button onclick="addProvider()">Save API Config</button>
    </div>
</div>

<div class="section">
    <h3 class="collapsible collapsed" onclick="toggleSection('manualLog')">📝 Log Manual Call</h3>
    <div id="manualLog" style="display:none">
        <select id="manualProvider">
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="gemini">Gemini</option>
            <option value="custom">Custom</option>
        </select>
        <input type="text" id="manualModel" placeholder="Model (e.g. gpt-4o)" />
        <input type="number" id="manualTokensIn" placeholder="Tokens In" />
        <input type="number" id="manualTokensOut" placeholder="Tokens Out" />
        <input type="number" id="manualLatency" placeholder="Latency (ms)" />
        <select id="manualStatus">
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="rate_limit">Rate Limit</option>
        </select>
        <button onclick="logManualCall()">Log Call</button>
    </div>
</div>

<button class="secondary" onclick="clearData()" style="margin-top:8px;opacity:0.7">🗑️ Clear All Data</button>

<script>
    const vscode = acquireVsCodeApi();
    function refresh() { vscode.postMessage({ type: 'refresh' }); }
    function toggleSection(id) {
        const el = document.getElementById(id);
        const header = el.previousElementSibling;
        if (el.style.display === 'none') { el.style.display = 'block'; header.classList.remove('collapsed'); }
        else { el.style.display = 'none'; header.classList.add('collapsed'); }
    }
    function addProvider() {
        const provider = document.getElementById('providerSelect').value;
        const apiKey = document.getElementById('apiKeyInput').value.trim();
        const endpoint = document.getElementById('endpointInput').value.trim();
        if (!apiKey) { alert('API key required!'); return; }
        vscode.postMessage({ type: 'addProvider', provider, apiKey, endpoint });
    }
    function logManualCall() {
        vscode.postMessage({ type: 'addManualCall', data: {
            provider: document.getElementById('manualProvider').value,
            model: document.getElementById('manualModel').value || 'unknown',
            tokensIn: parseInt(document.getElementById('manualTokensIn').value) || 0,
            tokensOut: parseInt(document.getElementById('manualTokensOut').value) || 0,
            latency: parseInt(document.getElementById('manualLatency').value) || 0,
            status: document.getElementById('manualStatus').value,
        }});
    }
    function clearData() {
        if (confirm('Clear all API call history?')) vscode.postMessage({ type: 'clearData' });
    }
</script>
</body>
</html>`;
    }

    private _providerIcon(provider: APIProvider | string): string {
        return ({ openai: '🤖', anthropic: '🔮', gemini: '💎', custom: '⚙️' } as any)[provider] || '⚙️';
    }
}

// ─── Workspace Scanner ────────────────────────────────────────────────────────

async function scanWorkspaceForAPICalls(context: vscode.ExtensionContext): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.{ts,js,py,env}', '**/node_modules/**', 100);
    const apiPatterns = [
        { regex: /sk-[a-zA-Z0-9]{20,}/g, provider: 'openai' },
        { regex: /sk-ant-[a-zA-Z0-9\-]{20,}/g, provider: 'anthropic' },
        { regex: /AIza[a-zA-Z0-9\-_]{30,}/g, provider: 'gemini' },
    ];
    const detected = new Set<string>();
    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        for (const pattern of apiPatterns) {
            if (text.match(pattern.regex)) detected.add(pattern.provider);
        }
    }
    if (detected.size > 0) {
        vscode.window.showInformationMessage(
            `🔮 Detected ${Array.from(detected).join(', ')} usage in workspace!`,
            'View Dashboard'
        ).then(a => { if (a) vscode.commands.executeCommand('apiHealthMonitor.dashboard.focus'); });
    }
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
    console.log('[API Health Monitor] Activated 🔮');

    // Start proxy server
    const proxy = new ProxyServer(3001, async (call) => {
        await dashboardProvider.addInterceptedCall(call);
    });

    await proxy.start();
    console.log(`[API Health Monitor] Proxy on port ${proxy.getPort()}`);

    // Stop proxy on deactivate
    context.subscriptions.push({ dispose: () => proxy.stop() });

    // Register sidebar
    const dashboardProvider = new APIHealthDashboardProvider(context, proxy.getPort());
    dashboardProvider.setProxyPort(proxy.getPort());

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            APIHealthDashboardProvider.viewType,
            dashboardProvider
        )
    );

    await scanWorkspaceForAPICalls(context);

    const refreshInterval = setInterval(() => dashboardProvider.refresh(), 30000);
    context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });

    context.subscriptions.push(
        vscode.commands.registerCommand('apiHealthMonitor.refresh', () => {
            dashboardProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('apiHealthMonitor.clearData', async () => {
            const state = getState(context);
            state.calls = [];
            await saveState(context, state);
            dashboardProvider.refresh();
            vscode.window.showInformationMessage('🗑️ All API data cleared!');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('apiHealthMonitor.scanWorkspace', async () => {
            await scanWorkspaceForAPICalls(context);
        })
    );
}

export function deactivate() {}