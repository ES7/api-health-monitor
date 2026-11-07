# Changelog

## 2.1.0

**API Health Monitor is now Agent Ledger.**

**Upgrading from API Health Monitor 0.0.x:** this release replaces the old proxy-based extension. Nothing needs to be configured: it reads your AI tools' local logs directly. The v1 code lives in [`v1/`](v1/).


- **Auto-detects your AI coding agents** on first run and tells you what it found. Each agent is now a self-contained provider, so adding more is one file.
- New: GitHub Copilot Chat (partial), Cline, Roo Code, Kilo Code, Gemini CLI, OpenCode.
- Detects Cursor, Windsurf, Kiro, Trae, Zed, Amp, Copilot CLI, Factory Droid, Qwen Code, Continue, Augment and Goose, and explains why their usage can't be counted locally.
- Finds extension-based agents in every VS Code-based editor (Insiders, VSCodium, Cursor, Windsurf, Antigravity…) and remote server installs.
- Uses the tool's own reported cost when it logs one. Copilot is shown as billed per request.
- New Agents tab: per-agent status, data folders and notes, and a one-click "ignore".
- Fix: Claude Code cache writes were double counted when streaming lines had different cache breakdowns.
- Cline tasks with a truncated log are recovered from Cline's own task history.
- Parallel parsing, per-provider cache invalidation, a scan log (Output → AI Usage), and 20 unit tests.
- Settings: `aiUsage.extraPaths` and `aiUsage.disabledAgents` replace the per-tool folder settings.

## 2.0.1

- Fix: Codex sessions resumed in a newer Codex build were under-counted. Token totals now come from Codex's running session totals, which were verified to match exactly.
- Fix: Claude Code responses logged several times while streaming now use their final token counts.

## 2.0.0

Rebuilt from scratch. v1 (API Health Monitor) used a local proxy; v2 reads the logs your AI coding agents already write.

- Claude Code, Codex (including zstd-compressed rollouts) and Antigravity (SQLite + protobuf) collectors
- GitHub-style usage calendar with day drill-down and streaks
- Overview, Activity, Sessions, Models, Projects, Limits and Sources tabs
- Codex rate-limit window and plan-value comparison
- API-equivalent cost estimates with per-model price overrides
- Incremental per-file cache that keeps history after tools delete old logs
- Status bar item and CSV export
- No API keys stored, no network access
