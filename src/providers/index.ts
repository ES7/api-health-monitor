import { Provider } from '../core/provider';
import { claudeCode } from './claudeCode';
import { codex } from './codex';
import { antigravity } from './antigravity';
import { copilotChat } from './copilotChat';
import { clineFamily } from './clineFamily';
import { geminiCli } from './geminiCli';
import { opencode } from './opencode';
import { detectOnlyProviders } from './detectOnly';

/**
 * Every supported tool, in display order. To add one: implement Provider in its
 * own file, add it here, and add a test under src/test.
 */
export const PROVIDERS: Provider[] = [
    claudeCode,
    codex,
    copilotChat,
    clineFamily({ id: 'cline', name: 'Cline', color: '#E5C07B', extensionIds: ['saoudrizwan.claude-dev'] }),
    clineFamily({ id: 'roo-code', name: 'Roo Code', color: '#C678DD', extensionIds: ['rooveterinaryinc.roo-cline'] }),
    clineFamily({ id: 'kilo-code', name: 'Kilo Code', color: '#F8F675', extensionIds: ['kilocode.kilo-code'] }),
    geminiCli,
    antigravity,
    opencode,
    ...detectOnlyProviders,
];

export function providerById(id: string): Provider | undefined {
    return PROVIDERS.find(p => p.id === id);
}
