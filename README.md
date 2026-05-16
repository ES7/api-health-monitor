# 🔮 API Health Monitor — VS Code Extension

> Monitor your AI API usage, cost, latency and health — directly inside VS Code. Supports OpenAI, Anthropic, Gemini, and custom APIs.

---

## 🎯 Inspiration

Developers using AI APIs (Cline, Copilot, custom LLM apps) have no idea how much they're spending, which calls are slow, or when rate limits hit — until the bill arrives. This extension brings real-time API observability directly into your editor.

---

## ✨ Features

- 💰 **Cost Tracking** — real-time cost per call, today, and this month
- ⚡ **Latency Monitor** — average and per-call response times
- 🚨 **Error & Rate Limit Alerts** — instant warnings in the dashboard
- 📊 **Provider Breakdown** — OpenAI vs Anthropic vs Gemini usage
- 🕐 **Recent Calls** — last 10 API calls with model, latency, cost, status
- 🚀 **Auto Proxy** — route calls through local proxy for automatic tracking
- 📝 **Manual Logging** — log calls manually from the dashboard
- 🔍 **Workspace Scanner** — detects API keys in your codebase

---

## 📁 Project Structure

```
api-health-monitor/
├── src/
│    ├── extension.ts      # Main extension + sidebar dashboard
│    └── proxy.ts          # Local HTTP proxy server
├── package.json           # Extension manifest & metadata
├── package-lock.json      # Dependency lock file
└── tsconfig.json          # TypeScript compiler config
```

---

## ⚙️ How It Works

```
Your Code → http://127.0.0.1:3001/openai    → api.openai.com
            http://127.0.0.1:3001/anthropic  → api.anthropic.com
            http://127.0.0.1:3001/gemini     → googleapis.com
                        ↓
            Proxy intercepts response
            Extracts: model, tokens, latency, status
                        ↓
            Dashboard updates automatically 🔮
```

---

## 🚀 Getting Started

### Prerequisites
- VS Code `^1.120.0`
- Node.js
- npm

### Run in Development Mode

```bash
# 1. Clone the repo
git clone https://github.com/ES7/api-health-monitor.git
cd api-health-monitor

# 2. Install dependencies
npm install

# 3. Compile
npm run compile

# 4. Press F5 in VS Code
```

A new VS Code window opens — click the **pulse icon** in the activity bar to open the dashboard.

---

### Build & Install as VSIX

```bash
npm install -g @vscode/vsce
npm run compile
vsce package
```

```
Ctrl+Shift+P → "Extensions: Install from VSIX" → select .vsix file
```

---

## 🔌 Connecting Your Code to the Proxy

### Python — Gemini
```python
from google import genai
from google.genai import types

client = genai.Client(
    api_key="YOUR_API_KEY",
    http_options=types.HttpOptions(base_url="http://127.0.0.1:3001/gemini")
)
```

### Python — OpenAI
```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://127.0.0.1:3001/openai/v1"
)
```

### Python — Anthropic
```python
import anthropic

client = anthropic.Anthropic(
    api_key="YOUR_API_KEY",
    base_url="http://127.0.0.1:3001/anthropic"
)
```

---

## 🧪 Testing

A test script is included to verify the proxy is working:

```bash
pip install httpx
python test_proxy.py
```

---

## 💰 Supported Models & Pricing

| Model | Input (per 1K) | Output (per 1K) |
|---|---|---|
| gpt-4o | $0.0025 | $0.010 |
| gpt-4o-mini | $0.00015 | $0.0006 |
| claude-opus-4 | $0.015 | $0.075 |
| claude-sonnet-4 | $0.003 | $0.015 |
| gemini-2.5-flash | $0.00015 | $0.0006 |
| gemini-1.5-pro | $0.00125 | $0.005 |

---

## 🛠️ Built With

- TypeScript
- VS Code Extension API (Webview)
- Node.js `http`/`https`/`zlib` — proxy & decompression

---

## 📜 License

MIT