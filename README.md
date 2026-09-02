# 🤖 Local Autonomous AI Coding Agent

> A fast, extensible, local-first autonomous AI coding assistant built with **TypeScript & Bun**. Designed to run seamlessly with local **Ollama** models (Granite, Qwen Coder, Gemma, Mistral, Liquid LFM) and cloud LLMs via OpenAI-compatible endpoints.

---

## 🌟 Highlights & Features

### ⚡ 1. Local & Multi-Model Engine
- **Dynamic Model Switching**: Switch models on the fly with the arrow-key interactive picker (`/model`) or CLI flag (`-m granite`, `-m qwen`, `-m gemma`, `-m ministral`, `-m lfm`, `-m qwen3.5`).
- **Dynamic Context Budgeting**: Queries Ollama's `/api/show` in real-time to track architectural limits (e.g. 131k for Granite) vs. active session context (`num_ctx`).
- **Bespoke ASCII Art Identity**: Every model displays a custom ASCII art identity banner on startup and switch.

### 🧠 2. Claude Code Style Live Thinking Stream
- **Real-Time Intent Stages**: As reasoning models deliberate, a single-line status transitions through live intent phases:
  - `⠋ Thinking (1.2s)...` ➔ `⠹ Analyzing approach (3.4s)...` ➔ `⠼ Synthesizing steps (8.5s)...` ➔ `⠸ Finalizing response (18.1s)...`
- **Clean Collapse**: Cleanly collapses to `✨ Thought for 3.1s` before streaming the clean answer text.
- **Configurable Reasoning Effort**: Toggle reasoning depth via `--thinking low` / `/thinking low` for **5x faster completions** or `--thinking off` for instant direct answers.

### 📷 3. Multimodal Vision Input
- **Vision-Capable Support**: Seamlessly analyzes images with `gemma3-tools:4b`, `ministral-3:3b`, and `qwen3.5:4b`.
- **Automatic Base64 Encoding**: Automatically reads `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg` files and attaches standard multimodal blocks.
- **Usage**:
  ```bash
  bun app/main.ts -m gemma --image screenshot.png -p "Explain the UI structure in this mockup"
  ```

### 🎨 4. Rich Terminal Markdown Streaming
- **Live Line-Buffered Renderer**:
  - Converts raw markdown into styled ANSI terminal typography in real-time.
  - Formats **headers**, **bold text**, **bullet lists**, **numbered steps**, **blockquotes**, and **tables**.
  - Renders **syntax-highlighted code blocks** inside framed ASCII boxes (`┌── typescript ──┐`).

### 🌍 5. System & Environment Awareness (`inspect("hardware")`)
- Complete hardware and telemetry inspection with hardware-aware model orchestration:
  - **`os()`**: Windows/Linux distribution, kernel version, platform architecture.
  - **`cpu()`**: CPU model name, logical core count, clock speeds.
  - **`memory()`**: Total, used, free RAM in GB and percentage utilization.
  - **`gpu()`**: Dedicated GPU name (e.g. `NVIDIA RTX 3050 Laptop`), total VRAM, and real-time available VRAM.
  - **`network()` & `runtime()`**: Active network interfaces, local IP, runtime (Bun/Node.js), process PID, and memory RSS.
  - **Hardware-Aware Model Orchestrator**: Automatically recommends and switches to the optimal local model based on real-time VRAM/RAM constraints (e.g. recommending `granite` or `gemma` for 4GB VRAM).

### 🧹 7. Project Garbage Collector & Codebase Entropy Engine (`/entropy` & `DeadCodeScan`)
- A dedicated cleaner organ that discovers everything nobody uses anymore:
  - **Unused Dependencies**: Scans `package.json` against all project imports.
  - **Dead / Orphan Exports**: Pinpoints exported functions, types, and constants with 0 consumers outside their declaring file.
  - **Orphaned Source Files**: Finds code files that are never imported anywhere.
  - **Stale Environment Variables**: Identifies `.env` keys never referenced in code.
  - **Project Entropy Score**: Calculates overall codebase entropy percentage (e.g. `12% [🟢 Clean]`) with actionable cleanup instructions.
  - **REPL Slash Command**: Type `/entropy` or `/gc` in the interactive terminal for an instant codebase health audit.

### 🧅 8. Request & Response Middleware Pipeline (`.agents/middleware/`)
- Distinct from event-based **Hooks**, **Middleware** intercepts and mutates the live request/response stream:
  ```text
  User Prompt ➔ [Middleware 1] ➔ [Middleware 2] ➔ Model ➔ [Middleware 2] ➔ [Middleware 1] ➔ Response
  ```
- **Capabilities**:
  - **`beforeRequest(ctx)`**: Inspect, mutate, or enrich `prompt`, `messages`, `tools`, `modelParams`, or **short-circuit** response without hitting the LLM.
  - **`afterResponse(ctx)`**: Clean, format, sanitize, redact API keys/secrets, or transform model outputs.
  - **Onion Execution Order**: Lower priority executes first on incoming requests and last on outgoing responses.
  - **Dynamic Extension**: Automatically loads `.ts`/`.js` middleware modules from `.agents/middleware/` (e.g. `security.ts`, `compression.ts`, `logging.ts`, `routing.ts`, `cost.ts`).
  - **REPL Slash Command**: Type `/middleware` in the terminal to inspect all active interceptors.

### 🔄 9. Explicit Agent Lifecycle State Machine (`app/state-machine.ts`)
- Gives the agent an explicit, deterministic state lifecycle:
  ```text
  IDLE ➔ UNDERSTANDING ➔ PLANNING ➔ EXECUTING ➔ VERIFYING ➔ WAITING ➔ COMPLETED
  ```
- **Capabilities**:
  - **State Ownership**: Owns agent state and validates state transitions (`onEnter`, `onExit`, `onTransition`).
  - **Subsystem Subscriptions**: UI, Telemetry, Permissions, Hooks, and JSON-RPC servers can subscribe to `state.changed` transitions.
  - **Dwell Time & Transition Tracing**: Tracks exact dwell times per state for deep performance profiling.
  - **REPL Slash Command**: Type `/state` or `/lifecycle` in the terminal to inspect the active state and lifecycle transition timeline.

### 🧠 10. Autonomous Evaluator & Self-Improvement Engine (`app/evaluators.ts`)
- Independent scoring organ that judges output quality and provides actionable critique:
  ```text
  Coder ➔ Evaluator ➔ Score (e.g. 72/100) ➔ Verdict (ACCEPT / RETRY) ➔ Self-Improvement
  ```
- **Evaluation Criteria**:
  - **`CodeEvaluator`** (weight 0.25): Detects unexecuted tool JSON leaks, unclosed code fences, and empty answers.
  - **`SecurityEvaluator`** (weight 0.25): Inspects for exposed API keys (`ghp_`, `sk-`), tokens, and destructive shell commands (`rm -rf`).
  - **`TaskEvaluator`** (weight 0.30): Validates prompt intent, file modifications, and requested item counts.
  - **`StyleEvaluator`** (weight 0.20): Strips leftover `<think>` tags and conversational fluff.
- **Model Tool & Slash Command**:
  - **Tool**: `EvaluateOutput(output)` for autonomous LLM reflection.
  - **Slash Command**: `/eval` or `/judge` in the REPL terminal to score the latest assistant response.

### 🗜️ 11. Context Compression & Low-VRAM Summarization Engine
- Tailored for low-memory local models (3B / 7B / 8B) and tight 4GB VRAM limits so the model never overflows context or chokes on massive 10,000-line files:
  - **`extract_symbols(filePath)`**: Extracts all function signatures, classes, interfaces, and types from a file without keeping the internal bodies (up to **95% token savings**).
  - **`summarize_file(filePath)`**: Generates a high-level compressed skeleton, dependencies, and structural outline.
  - **`context_extract(filePath, query, radius)`**: Slices a focused window around a target function, keyword, or line number with custom radius (e.g. 15 lines).
  - **`summarize_diff(filePath)`**: Returns compact statistics and functional summaries of uncommitted git diffs.
  - **`compress_history(messages)`**: Intelligently digests older turns into a structured summary when approaching context limits.

### 🧰 7. On-Demand Tool Discovery & Progressive Context Loading
- Instead of dumping 50+ tool schemas into every prompt payload (wasting thousands of context tokens):
  - **Lean Core Toolset**: Initially activates only high-leverage core primitives (`Inspect`, `Read`, `Write`, `Edit`, `Tree`, `Find`, `Grep`, `Bash`, `ToolSearch`, `ToolsAvailable`).
  - **`ToolsAvailable()`**: Lists available catalogs across categories (`filesystem`, `navigation`, `web`, `database`, `mcp`, `specialized`) without loading their JSON schemas into prompt context.
  - **`ToolSearch("query")`**: Dynamically searches and hot-loads specialized capabilities (e.g. `WebSearch`, LSP symbol tools, custom database tools, or MCP servers) into the active toolset on-demand.

### 🗂️ 7. Specialized Filesystem Intelligence Tools
- Native, token-efficient tools so the LLM doesn't rely on raw Bash commands for every inspection:
  - **`Edit`**: First-class structural code modification (`replace`, `insert_after`, `insert_before`, `delete`, `append`, `prepend`) with AST syntax protection.
  - **`Tree`**: Structured, depth-limited ASCII directory hierarchy (e.g. `tree("src/", 2)`).
  - **`Find`**: Instant filename & substring finder (e.g. `find("package.json")`).
  - **`Glob`**: Fast glob pattern matching across projects (e.g. `glob("src/**/*.ts")`).
  - **`Grep`**: Content regex/keyword search with exact line numbers (e.g. `grep("TODO", "src/")`).

### ⚡ 8. Unified AgentEvent Stream Architecture (`AgentEventBus`)
- Strongly-typed reactive pub/sub event bus (`app/events.ts`) unifying all internal communication:
  - **`session.started` / `session.ended`**: Session initialization and overall lifecycle milestones.
  - **`model.started` / `model.completed`**: Model generation timings, token counts, and speed metrics.
  - **`token.streamed`**: Real-time token streaming chunks (content and reasoning/thinking tokens).
  - **`permission.requested` / `permission.resolved`**: Real-time permission gate state changes.
  - **`tool.started` / `tool.completed`**: Tool invocations, durations, errors, and sanitized outputs.
  - **`file.changed`**: Granular notifications when files are created (`Write`) or edited (`Edit`).
- **Unified Subscribers**: TUI REPL, JSON-RPC Server (VS Code / Web UI), Telemetry loggers, and Plugins all subscribe to the exact same stream with zero coupling!

### 🔍 9. Language Server Protocol (LSP) Navigation
- Direct integration with local language servers (`typescript-language-server`, `pyright`, `gopls`, `rust-analyzer`, `clangd`):
  - `LSP_Definition`: Go to definition across files.
  - `LSP_References`: Find all symbol usages in the codebase.
  - `LSP_DocumentSymbols`: Inspect file outline and function signatures.
  - `LSP_Hover`: Inspect type signatures and docstrings.

### 🔌 7. Model Context Protocol (MCP) & Web Search
- **MCP Integration**: Connects to external tool servers via standard stdio JSON-RPC (`.agents/mcp.json`).
- **Live Web Search**: Built-in DuckDuckGo search integration for up-to-date documentation and package lookups.

### 🔒 8. Multi-Tier Security Guardrails
- **Path Traversal Shield**: Blocks access to sensitive SSH keys (`~/.ssh/id_rsa`), AWS credentials, and root OS directories (`C:\Windows`, `/etc/shadow`).
- **Destructive Command Interception**: Intercepts `rm -rf /`, `del /s /q C:\`, format commands, fork bombs, and system reboots.
- **Runaway Loop Detection**: Intercepts repetitive tool calls if a model loops 3 times on the same arguments.
- **Secret Redaction**: Automatically scrubs API keys and private tokens from logs and responses.

### 📦 9. Unified Single-File Session & Telemetry
- All conversation turns and telemetry metrics (TTFT, generation tokens/sec, context usage) are recorded in a single file per session under `.agents/sessions/<session_id>.jsonl`.

---

## 🏗️ Architecture Overview

```text
├── app/
│   ├── main.ts          # CLI entry point, argument router & flag parser
│   ├── agent.ts         # Core autonomous reasoning & execution loop
│   ├── repl.ts          # Interactive TUI, token streaming & slash commands
│   ├── server.ts        # Headless JSON-RPC 2.0 stdio server for IDE integrations
│   ├── markdown.ts      # Real-time ANSI terminal markdown streaming engine
│   ├── banners.ts       # Model-specific ASCII art identity banners
│   ├── guardrails.ts    # Security validations, path protection & loop detector
│   ├── models.ts        # Model registry loader & interactive arrow-key selector
│   ├── telemetry.ts     # Dynamic context monitoring & tokens/sec metrics
│   ├── permissions.ts   # Policy evaluation & arrow-key approval dialog
│   ├── hooks.ts         # Lifecycle event hooks (pre_tool_call, on_session_end)
│   ├── skills.ts        # Modular skill loader (.agents/skills/)
│   ├── commands.ts      # Custom slash commands (.agents/commands/)
│   ├── lsp-service.ts   # Language Server Protocol client coordinator
│   ├── mcp-client.ts    # Model Context Protocol stdio client
│   └── web-search.ts    # Live web search integration
├── .agents/             # Project configuration (models, permissions, hooks, sessions)
└── package.json
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **[Bun Runtime](https://bun.sh/)** (v1.1+ recommended)
- **[Ollama](https://ollama.ai/)** running locally on `http://localhost:11434`
- Pulled local models (e.g. `ollama pull ibm/granite4.2:3b`, `ollama pull qwen2.5-coder:7b-instruct-q3_k_m`)

### 2. Setup
Clone the repository and install dependencies:
```bash
git clone https://github.com/Snaehath/ai-coding-agent.git
cd ai-coding-agent
bun install
```

Configure environment variables in `.env`:
```env
OPENROUTER_API_KEY="ollama"
OPENROUTER_BASE_URL="http://localhost:11434/v1"
MODEL="qwen2.5-coder:7b-instruct-q3_k_m"
```

---

## 💻 Usage Guide

### 💬 1. Interactive REPL Mode
Launch the interactive coding terminal:
```bash
bun app/main.ts
```

#### System Slash Commands:
| Command | Description |
| :--- | :--- |
| `/help` | Show available system and custom commands |
| `/model` | Open the interactive arrow-key model selector |
| `/thinking [low\|high\|off]` | Adjust chain-of-thought reasoning depth |
| `/image <path> [prompt]` | Attach an image file for vision analysis |
| `/stats` | Display real-time session telemetry & context budget |
| `/compact` | Compress conversation history to save tokens |
| `/skills` | List active agent skills |
| `/permissions` | Inspect active permission security policies |
| `/hooks` | Inspect active lifecycle hooks |
| `/history` | View recent session messages |
| `/sessions` | List saved sessions |
| `/clear` | Start a fresh session |
| `/exit` | Quit the agent |

---

### ⚡ 2. Single-Prompt CLI Mode (`-p`)
Run one-off prompts and piping directly in your terminal:

```bash
# Code review with Qwen Coder
bun app/main.ts -m qwen -p "Review app/agent.ts for potential memory leaks"

# Fast reasoning with Granite (low effort)
bun app/main.ts -m granite --thinking low -p "Explain the producer-consumer pattern with an example"

# Multimodal image analysis with Gemma
bun app/main.ts -m gemma --image screenshot.png -p "Describe this architecture diagram"

# Search live documentation
bun app/main.ts -p "Search web for Bun 1.4 release notes and summarize key changes"
```

---

### 🌐 3. Running in Any Codebase
To use this agent globally inside any project on your computer:

```bash
# Register global command
bun link

# Now run from any directory:
cd /path/to/my-react-app
ai-agent -m granite -p "Analyze this codebase and list the main components"
```

---

## 📊 Telemetry & Context Budgeting

Run `/stats` or `--stats` anytime to view real-time performance metrics:

```text
╭────────────── Agent Telemetry ──────────────╮
│ Model                          granite4.2:3b │
│ Session                                 1m 0s│
│ Turns                                      2 │
│ Tokens                                   768 │
│                                              │
│ Context Budget:                              │
│   ░░░░░░░░░░░░░░░░░░  1%                     │
│   768 / 65,536 tokens                        │
│                                              │
│ Model context limit                  131,072 │
│ Configured context                    65,536 │
│ Current usage                            768 │
│ Remaining                             64,768 │
│                                              │
│ TTFT                                   0.45s │
│ Generation                        32.4 tok/s │
│ Tool calls                                 1 │
│ Tool time                               0.2s │
│ Errors                                     0 │
╰────────────────────────────────────────────╯
```

---

## 🤝 Roadmap & Open Areas for Feedback

We would love your ideas and suggestions! Here are some areas currently being explored:

- [ ] **Unified Diff & Patch Editing**: Smarter AST/diff-based file editing for large codebases.
- [ ] **Multi-Agent Swarm Mode**: Specialized subagents (Planner, Architect, Coder, Reviewer, Tester).
- [ ] **Background Watcher / Daemon Mode**: Autonomous test-driven repair on file save.
- [ ] **VS Code & Web UI Companion**: Lightweight sidecar extension connecting to `app/server.ts`.

---

## 📜 License
MIT © 2026 Snaehath. Feel free to use, modify, and contribute!
