import * as path from 'path';
import { Provider } from '../core/provider';
import { appConfigDir, existingDirs, home, xdgDataDirs } from '../core/paths';

/**
 * Tools we can recognise on disk but whose token usage is not stored locally in a
 * readable form (kept server-side, or a format not supported yet). They are listed
 * so users see every agent they use, with an honest reason instead of a fake zero.
 */
function detectOnly(id: string, name: string, color: string, candidates: () => (string | undefined)[], note: string): Provider {
    return {
        id, name, color,
        support: 'detect-only',
        version: 1,
        async discover(ctx) {
            const roots = existingDirs([...candidates(), ...ctx.extraPaths]);
            return { roots, files: [], notes: roots.length ? [note] : [] };
        },
    };
}

const cfg = (...p: string[]) => path.join(appConfigDir(), ...p);
const h = (...p: string[]) => path.join(home(), ...p);
const data = (...p: string[]) => xdgDataDirs().map(d => path.join(d, ...p));

export const detectOnlyProviders: Provider[] = [
    detectOnly('cursor', 'Cursor', '#7C7C7C', () => [cfg('Cursor'), h('.cursor')],
        'Cursor keeps token usage on its servers, not on your computer. See cursor.com/dashboard → Usage. (Claude Code, Codex, Cline and Copilot used inside Cursor are still counted.)'),
    detectOnly('windsurf', 'Windsurf', '#09B6A2', () => [cfg('Windsurf'), h('.codeium', 'windsurf')],
        'Windsurf keeps credit usage on its servers, not on your computer. See your Windsurf account page. (Extensions like Cline used inside Windsurf are still counted.)'),
    detectOnly('kiro', 'Kiro', '#7B61FF', () => [cfg('Kiro'), h('.kiro')],
        'Kiro usage is not supported yet.'),
    detectOnly('trae', 'Trae', '#FF5A36', () => [cfg('Trae'), h('.trae')],
        'Trae keeps usage on its servers, not on your computer.'),
    detectOnly('zed', 'Zed Agent', '#084CCF', () => [cfg('Zed'), ...data('zed')],
        'Zed agent threads are not supported yet.'),
    detectOnly('copilot-cli', 'Copilot CLI', '#6E40C9', () => [h('.copilot')],
        'GitHub Copilot CLI does not write token usage to its local logs. Copilot Chat inside VS Code is counted under "GitHub Copilot".'),
    detectOnly('amp', 'Amp', '#F34E3F', () => [...data('amp'), h('.config', 'amp')],
        'Amp keeps thread usage on its servers. See ampcode.com/settings.'),
    detectOnly('factory-droid', 'Factory Droid', '#E07A2E', () => [h('.factory')],
        'Factory Droid sessions are not supported yet.'),
    detectOnly('qwen-code', 'Qwen Code', '#615CED', () => [h('.qwen')],
        'Qwen Code sessions are not supported yet.'),
    detectOnly('continue', 'Continue', '#BE1E55', () => [h('.continue')],
        'Continue usage is not supported yet.'),
    detectOnly('augment', 'Augment', '#5B5BD6', () => [h('.augment')],
        'Augment keeps usage on its servers.'),
    detectOnly('goose', 'Goose', '#3D3D3D', () => [...data('goose'), cfg('Block', 'goose')],
        'Goose sessions are not supported yet.'),
];
