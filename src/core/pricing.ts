import { UsageRecord } from './types';

/** USD per 1M tokens. */
export interface Price {
    input: number;
    output: number;
    cacheRead: number;
    /** 5-minute cache write; defaults to 1.25x input for Claude, 1x elsewhere. */
    cacheWrite?: number;
}

interface PriceRule { match: RegExp; price: Price; label: string }

/**
 * Public list prices (checked Nov 2026). These are API-equivalent estimates:
 * if you are on a subscription (Claude Pro/Max, ChatGPT plan, Google AI plan)
 * you are not billed per token, but this is what the same usage would cost on the API.
 * Order matters: first match wins. Model names are normalized (lowercase, '.', '_' and spaces -> '-').
 */
const RULES: PriceRule[] = [
    // Free tiers (OpenRouter ":free" models and similar) win over everything else.
    { label: 'Free model', match: /:free$|-free$/, price: { input: 0, output: 0, cacheRead: 0 } },
    // Anthropic
    { label: 'Claude Fable 5.1 / Mythos 5.1', match: /(fable|mythos)-5-1/, price: { input: 10, output: 50, cacheRead: 0.25 } },
    { label: 'Claude Fable / Mythos', match: /fable|mythos/, price: { input: 10, output: 50, cacheRead: 1 } },
    { label: 'Claude Opus 5.5', match: /opus-5-5/, price: { input: 4, output: 20, cacheRead: 0.2 } },
    { label: 'Claude Opus 5 / 4.5-4.8', match: /opus-(5|4-[5-9])/, price: { input: 5, output: 25, cacheRead: 0.5 } },
    { label: 'Claude Opus 4 / 4.1', match: /opus/, price: { input: 15, output: 75, cacheRead: 1.5 } },
    { label: 'Claude Sonnet 5 / 5.5', match: /sonnet-5/, price: { input: 2, output: 10, cacheRead: 0.2 } },
    { label: 'Claude Sonnet 3.x / 4.x', match: /sonnet/, price: { input: 3, output: 15, cacheRead: 0.3 } },
    { label: 'Claude Haiku 5.5', match: /haiku-5/, price: { input: 0.1, output: 0.5, cacheRead: 0.01 } },
    { label: 'Claude Haiku 4.5', match: /haiku-4/, price: { input: 1, output: 5, cacheRead: 0.1 } },
    { label: 'Claude Haiku 3.5', match: /haiku/, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
    // OpenAI
    { label: 'GPT-5.6 Sol', match: /gpt-5-6-sol/, price: { input: 4, output: 20, cacheRead: 0.4 } },
    { label: 'GPT-5.6 Terra', match: /gpt-5-6-terra/, price: { input: 2, output: 12, cacheRead: 0.2 } },
    { label: 'GPT-5.6 Luna', match: /gpt-5-6-luna/, price: { input: 0.2, output: 1.2, cacheRead: 0.02 } },
    { label: 'GPT-5.6 Cyber', match: /gpt-5-6-cyber/, price: { input: 12.5, output: 75, cacheRead: 1.25 } },
    { label: 'GPT-5.6', match: /gpt-5-6/, price: { input: 4, output: 20, cacheRead: 0.4 } },
    { label: 'GPT-5.5 Pro', match: /gpt-5-5-pro/, price: { input: 30, output: 180, cacheRead: 3 } },
    { label: 'GPT-5.5', match: /gpt-5-5/, price: { input: 5, output: 30, cacheRead: 0.5 } },
    { label: 'GPT-5.x Codex', match: /codex/, price: { input: 1.75, output: 14, cacheRead: 0.175 } },
    { label: 'GPT-5.4', match: /gpt-5-4/, price: { input: 2.5, output: 15, cacheRead: 0.25 } },
    { label: 'GPT-5.2 / 5.3', match: /gpt-5-[23]/, price: { input: 1.75, output: 14, cacheRead: 0.175 } },
    { label: 'GPT-5 mini', match: /gpt-5.*mini/, price: { input: 0.25, output: 2, cacheRead: 0.025 } },
    { label: 'GPT-4.1', match: /gpt-4-1/, price: { input: 2, output: 8, cacheRead: 0.5 } },
    { label: 'GPT-4o mini', match: /gpt-4o-mini|4o-mini/, price: { input: 0.15, output: 0.6, cacheRead: 0.075 } },
    { label: 'GPT-4o', match: /gpt-4o|chatgpt-4o/, price: { input: 2.5, output: 10, cacheRead: 1.25 } },
    { label: 'o3 / o4-mini', match: /(^|[/-])o4-mini/, price: { input: 1.1, output: 4.4, cacheRead: 0.275 } },
    { label: 'o3', match: /(^|[/-])o3($|-)/, price: { input: 2, output: 8, cacheRead: 0.5 } },
    { label: 'GPT-5', match: /gpt-5/, price: { input: 1.25, output: 10, cacheRead: 0.125 } },
    { label: 'gpt-oss', match: /gpt-oss/, price: { input: 0.15, output: 0.6, cacheRead: 0.15 } },
    // xAI
    { label: 'Grok Code Fast', match: /grok-code-fast/, price: { input: 0.2, output: 1.5, cacheRead: 0.02 } },
    { label: 'Grok 4', match: /grok-4/, price: { input: 3, output: 15, cacheRead: 0.75 } },
    // DeepSeek
    { label: 'DeepSeek', match: /deepseek/, price: { input: 0.28, output: 0.42, cacheRead: 0.028 } },
    // Google
    { label: 'Gemini Pro', match: /gemini.*pro|gemini-pro/, price: { input: 2, output: 12, cacheRead: 0.2 } },
    { label: 'Gemini Flash-Lite', match: /flash-lite/, price: { input: 0.1, output: 0.4, cacheRead: 0.01 } },
    { label: 'Gemini Flash', match: /flash/, price: { input: 0.5, output: 3, cacheRead: 0.05 } },
    { label: 'Gemini', match: /gemini/, price: { input: 2, output: 12, cacheRead: 0.2 } },
];

export function normalizeModel(model: string): string {
    return model.toLowerCase().replace(/[\s._]+/g, '-');
}

export class Pricer {
    private cache = new Map<string, { price: Price; label: string } | null>();
    constructor(private overrides: Record<string, Partial<Price>> = {}) {}

    lookup(model: string): { price: Price; label: string } | null {
        const hit = this.cache.get(model);
        if (hit !== undefined) { return hit; }
        const n = normalizeModel(model);
        let found: { price: Price; label: string } | null = null;
        for (const [key, p] of Object.entries(this.overrides)) {
            if (n.includes(normalizeModel(key))) {
                found = { price: { input: p.input ?? 0, output: p.output ?? 0, cacheRead: p.cacheRead ?? 0, cacheWrite: p.cacheWrite }, label: `custom (${key})` };
                break;
            }
        }
        if (!found) {
            const r = RULES.find(x => x.match.test(n));
            if (r) { found = { price: r.price, label: r.label }; }
        }
        this.cache.set(model, found);
        return found;
    }

    /**
     * USD cost of one record: the tool's own reported cost when it logs one,
     * otherwise an estimate from list prices (0 when the model is unknown).
     */
    cost(r: UsageRecord): number {
        if (typeof r.costUsd === 'number' && isFinite(r.costUsd)) { return Math.max(0, r.costUsd); }
        return this.estimate(r);
    }

    estimate(r: UsageRecord): number {
        const hit = this.lookup(r.model);
        if (!hit) { return 0; }
        const p = hit.price;
        const isClaude = /claude|opus|sonnet|haiku|fable|mythos/.test(normalizeModel(r.model));
        const cw = p.cacheWrite ?? (isClaude ? p.input * 1.25 : p.input);
        const cw1h = isClaude ? p.input * 2 : cw;
        let usd = (r.input * p.input + r.output * p.output + r.cacheRead * p.cacheRead + r.cacheWrite * cw + r.cacheWrite1h * cw1h) / 1e6;
        if (r.fast) { usd *= 2; }
        return usd;
    }
}
