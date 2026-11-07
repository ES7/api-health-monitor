import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';

export interface InterceptedCall {
    provider: 'openai' | 'anthropic' | 'gemini' | 'custom';
    model: string;
    tokensIn: number;
    tokensOut: number;
    latency: number;
    status: 'success' | 'error' | 'rate_limit';
    error?: string;
    timestamp: number;
}

export type CallHandler = (call: InterceptedCall) => void;

const PROVIDER_TARGETS: Record<string, { host: string; provider: InterceptedCall['provider'] }> = {
    '/openai':    { host: 'api.openai.com',                    provider: 'openai' },
    '/anthropic': { host: 'api.anthropic.com',                 provider: 'anthropic' },
    '/gemini':    { host: 'generativelanguage.googleapis.com', provider: 'gemini' },
};

function extractModel(body: any, url: string, provider: string): string {
    try {
        if (provider === 'openai')    return body?.model || 'gpt-4o';
        if (provider === 'anthropic') return body?.model || 'claude-sonnet-4';
        if (provider === 'gemini') {
            // Gemini model is in URL: /v1beta/models/gemini-1.5-flash:generateContent
            const match = url.match(/models\/([^/:]+)/);
            if (match) return match[1]; // e.g. "gemini-1.5-flash"
            return body?.model || 'gemini-1.5-flash';
        }
    } catch {}
    return 'unknown';
}

function extractTokens(responseBody: any, provider: string): { in: number; out: number } {
    try {
        if (provider === 'openai') {
            return {
                in: responseBody?.usage?.prompt_tokens || 0,
                out: responseBody?.usage?.completion_tokens || 0,
            };
        }
        if (provider === 'anthropic') {
            return {
                in: responseBody?.usage?.input_tokens || 0,
                out: responseBody?.usage?.output_tokens || 0,
            };
        }
        if (provider === 'gemini') {
            // Gemini puts usage in usageMetadata
            const usage = responseBody?.usageMetadata;
            if (usage) {
                return {
                    in: usage.promptTokenCount || 0,
                    out: usage.candidatesTokenCount || 0,
                };
            }
            // Also check candidates[0] for some versions
            const candidates = responseBody?.candidates;
            if (candidates && candidates[0]?.tokenCount) {
                return { in: 0, out: candidates[0].tokenCount };
            }
        }
    } catch {}
    return { in: 0, out: 0 };
}

export class ProxyServer {
    private server: http.Server | null = null;
    private port: number;
    private onCall: CallHandler;

    constructor(port: number, onCall: CallHandler) {
        this.port = port;
        this.onCall = onCall;
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    this.port++;
                    this.server?.listen(this.port);
                } else {
                    reject(err);
                }
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`[Proxy] Running on http://127.0.0.1:${this.port}`);
                resolve();
            });
        });
    }

    stop(): void {
        this.server?.close();
        this.server = null;
    }

    getPort(): number {
        return this.port;
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', '*');

        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', port: this.port }));
            return;
        }

        const urlPath = req.url || '';
        const providerKey = Object.keys(PROVIDER_TARGETS).find(k => urlPath.startsWith(k));

        if (!providerKey) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Unknown provider. Use /openai, /anthropic, or /gemini' }));
            return;
        }

        const target = PROVIDER_TARGETS[providerKey];
        const actualPath = urlPath.replace(providerKey, '') || '/';

        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const bodyRaw = Buffer.concat(chunks).toString();
            let requestBody: any = {};
            try { requestBody = JSON.parse(bodyRaw); } catch {}

            // Extract model from URL for Gemini, body for others
            const model = extractModel(requestBody, actualPath, target.provider);
            const startTime = Date.now();

            const options: https.RequestOptions = {
                hostname: target.host,
                path: actualPath,
                method: req.method,
                headers: { ...req.headers, host: target.host },
            };

            const proxyReq = https.request(options, (proxyRes) => {
                const responseChunks: Buffer[] = [];
                proxyRes.on('data', (chunk: Buffer) => {
                    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                });
                proxyRes.on('end', () => {
                    const latency = Date.now() - startTime;
                    const rawBuffer = Buffer.concat(responseChunks);
                    const encoding = proxyRes.headers['content-encoding'] || '';

                    const decompress = (buf: Buffer): Promise<string> => new Promise((resolve) => {
                        if (encoding.includes('gzip')) {
                            zlib.gunzip(buf, (_, result) => resolve(result?.toString('utf8') || ''));
                        } else if (encoding.includes('br')) {
                            zlib.brotliDecompress(buf, (_, result) => resolve(result?.toString('utf8') || ''));
                        } else if (encoding.includes('deflate')) {
                            zlib.inflate(buf, (_, result) => resolve(result?.toString('utf8') || ''));
                        } else {
                            resolve(buf.toString('utf8'));
                        }
                    });

                    decompress(rawBuffer).then(responseRaw => {

                    // Gemini sometimes sends newline-delimited JSON (streaming)
                    // Try parsing each line separately and merge usageMetadata
                    let responseBody: any = {};
                    try {
                        responseBody = JSON.parse(responseRaw);
                    } catch {
                        // Try line-by-line parsing (streaming/NDJSON)
                        const lines = responseRaw.split('\n').filter(l => l.trim());
                        let mergedUsage: any = null;
                        let mergedModel = '';
                        for (const line of lines) {
                            try {
                                const parsed = JSON.parse(line);
                                if (parsed.usageMetadata) mergedUsage = parsed.usageMetadata;
                                if (parsed.modelVersion) mergedModel = parsed.modelVersion;
                                if (parsed.model) mergedModel = parsed.model;
                            } catch {}
                        }
                        if (mergedUsage) responseBody.usageMetadata = mergedUsage;
                        if (mergedModel) responseBody.model = mergedModel;
                    }

                    console.log(`[Proxy] ${target.provider} response:`, JSON.stringify(responseBody).substring(0, 300));

                    const tokens = extractTokens(responseBody, target.provider);
                    const statusCode = proxyRes.statusCode || 200;

                    let status: InterceptedCall['status'] = 'success';
                    let error: string | undefined;

                    if (statusCode === 429) {
                        status = 'rate_limit';
                        error = 'Rate limit exceeded';
                    } else if (statusCode >= 400) {
                        status = 'error';
                        error = responseBody?.error?.message || `HTTP ${statusCode}`;
                    }

                    console.log(`[Proxy] ${target.provider} | model: ${model} | tokens: ${tokens.in}/${tokens.out} | latency: ${latency}ms | status: ${status}`);

                    this.onCall({
                        provider: target.provider,
                        model,
                        tokensIn: tokens.in,
                        tokensOut: tokens.out,
                        latency,
                        status,
                        error,
                        timestamp: Date.now(),
                    });

                    res.writeHead(statusCode, proxyRes.headers);
                    res.end(rawBuffer); // send original compressed buffer back
                    }); // end decompress
                });
            });

            proxyReq.on('error', (err) => {
                const latency = Date.now() - startTime;
                this.onCall({
                    provider: target.provider,
                    model,
                    tokensIn: 0,
                    tokensOut: 0,
                    latency,
                    status: 'error',
                    error: err.message,
                    timestamp: Date.now(),
                });
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            });

            if (bodyRaw) proxyReq.write(bodyRaw);
            proxyReq.end();
        });
    }
}