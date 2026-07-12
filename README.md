# AI Chat — Agentic vault assistant for Obsidian

An AI assistant that lives inside your Obsidian vault. It searches and reads your notes before answering, creates and edits notes on your behalf, and cites exactly what it opened — no hallucinated references.

Works with the hosted subscription (no API keys), your own Claude Code CLI, or any OpenAI-compatible endpoint (Ollama, LM Studio, DeepSeek, OpenRouter).

---

## Features

- **Agentic research** — the model calls `search_vault` and `read_note` in a loop, reading the actual content of your notes before answering. It doesn't guess from titles or snippets.
- **Write tools** — create, edit, append to, and delete notes. Every write shows a diff with Approve / Reject before anything changes.
- **Plain Q&A mode** — retrieves the most relevant chunks via BM25 and answers with `[[wikilink]]` citations, without a tool-calling loop.
- **Chat history** — sessions are saved in plugin data; switch between past conversations from the toolbar.
- **Effort levels** — Low (fast, cheap), Medium (balanced), High (thorough), Ultra (research mode: plans, searches 3+ phrasings, reads every candidate).
- **Theme-aware** — follows Obsidian's light/dark theme, or force one in settings.
- **Mobile-ready** on the hosted plan (not Claude Code CLI, which is desktop-only).

---

## Installation

### From Obsidian Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **AI Chat**.
3. Install and enable it.

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/SvyatoSllav/AI-Chat/releases/latest).
2. Copy them to `<your-vault>/.obsidian/plugins/ai-chat/`.
3. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

---

## Configuration

Open **Settings → AI Chat** to choose a provider.

### Hosted subscription (default)

No API key needed. Click **Sign in in browser** — a browser tab opens, you log in with email, and the plugin picks up the session automatically.

**Free tier:** 5 messages to try the plugin.  
**Pro:** unlimited messages, direct connection to the model (no traffic through the server).

[Subscribe →](https://zettelkasten-ai.com/#pricing)

### Claude Code CLI

Uses your existing Claude subscription via the official `claude` CLI. Desktop only.

1. Install the CLI: `npm install -g @anthropic-ai/claude-code`
2. Sign in once: `claude` in a terminal.
3. In plugin settings, select **Claude Code CLI** and set the binary path if it's not on `PATH`.

### Self-hosted / your own key (OpenAI-compatible)

Works with Ollama, LM Studio, DeepSeek, OpenRouter, or any OpenAI-compatible endpoint.

Use the **Preset** dropdown to fill in the URL and model automatically, then add your API key.

**Ollama (fully local, free):**
```
Base URL: http://localhost:11434/v1
API Key:  ollama
Model:    qwen2.5:1.5b   (or any model you've pulled)
```

Pull a model: `ollama pull qwen2.5:1.5b`

---

## Usage

Click the **AI Chat** icon in the left ribbon (or run *Open AI Chat* from the command palette).

Type a question and press **Enter** (or click Send). In agent mode, you'll see each tool call logged in real time — search queries, note reads, file operations — before the final answer.

**Tips:**
- Keep the note you're working on open — the agent will read it first.
- Use **High** or **Ultra** effort for research tasks; **Low** for quick lookups.
- Toggle **Auto-approve** in settings to skip write confirmations (full autopilot mode).
- Start a **New session** from the toolbar to clear context.

---

## Pricing

| Plan | Price | Messages |
|---|---|---|
| Free | $0 | 5 messages |
| Monthly | $9/month | Unlimited |
| Annual | $72/year ($6/month) | Unlimited + 33% off |

Pro accounts connect directly to the model — no traffic goes through the backend server after the initial authentication.

---

## Privacy

- In **hosted** mode, your messages go to `zettelkasten-ai.com` (authentication and free-tier proxy) or directly to the model provider (Pro, after receiving a lease key). Note content is included in requests to the model.
- In **Claude Code CLI** and **OpenAI-compatible** modes, nothing goes through the hosted backend. All traffic goes to whichever endpoint you configured.
- The vault index (BM25 search) is built and stored entirely in-memory on your device. No note content is uploaded for indexing.

---

## Building from source

```bash
git clone https://github.com/SvyatoSllav/AI-Chat.git
cd AI-Chat
npm install
npm run build
```

Output: `main.js` and `styles.css` in the project root.

---

## License

MIT
