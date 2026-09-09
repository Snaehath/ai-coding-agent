# 🤖 Autonomous Local System Agent

> A fast, extensible, local-first autonomous system agent and developer copilot built with **TypeScript & Bun**. Designed to run seamlessly with local **Ollama** models (Granite, Qwen 3.5, Gemma 3, Ministral, Liquid LFM, Parable Fable) and cloud LLMs via OpenAI-compatible endpoints.

---

## 🌟 Highlights & Features

### ⚡ 1. Local Multi-Model Engine & Environment Awareness
- **Dynamic Model Switching**: Switch models on the fly with the arrow-key interactive picker (`/model`), instant alias switch (`/model fable`, `/model qwen3.5`, `/model gemma`, `/model ministral`, `/model granite`, `/model lfm`), or CLI flags (`-m <alias>`).
- **Installed Local Model Knowledge**: The agent possesses full runtime awareness of all registered local models in the environment. When asked for recommendations, it identifies the best model from your local roster rather than hallucinating unavailable cloud services.
- **Model Catalog (`/models`)**: Type `/models` to inspect all installed local models, their memory footprints, vision capabilities, and switch shortcuts.
- **Dynamic Context Budgeting**: Queries Ollama's `/api/show` in real-time to track architectural limits (e.g. 131k for Granite) vs. active session context (`num_ctx`).
- **Bespoke ASCII Art Identity**: Every model displays a custom ASCII art identity banner on startup and model switch.

#### 📊 Local Model Roster & Selection Matrix

| Model | Aliases | VRAM | Native Modality | Primary Strengths & Recommended Use Cases |
| :--- | :--- | :--- | :--- | :--- |
| **IBM Granite 4.2 3B** | `granite`, `ibm`, `granite4.2` | ~2.2 GB | Text & Code | Deep Chain-of-Thought reasoning, complex code refactoring, enterprise RAG, tool calling. |
| **Parable Fable 4B** | `fable`, `parable`, `fable4b` | ~2.5 GB | Text & Code | **Agentic reasoning** trained on Claude Fable & GPT-5.5 tool traces, `<think>` planning, multi-step execution. |
| **Qwen 3.5 4B** | `qwen3.5`, `qwen`, `alibaba` | ~3.4 GB | 📷 **Vision + Code** | **Complex image understanding**, OCR, UI mockups, architectural diagrams, reasoning, coding. |
| **Gemma 3 Tools 4B** | `gemma`, `gemma3`, `google` | ~3.3 GB | 📷 **Vision + Code** | **Multimodal image analysis**, function calling, general chat, multilingual reasoning. |
| **Mistral Ministral 3 3B**| `ministral`, `mistral` | ~3.0 GB | 📷 **Vision + Code** | **Fast vision analysis**, low-latency tool execution, structured JSON, document Q&A. |
| **Liquid LFM 2.5 8B** | `lfm`, `liquid`, `lfm2.5` | ~5.2 GB | Text & Code | Liquid neural state-space, multi-step tool chaining, low-latency on-device agentic tasks. |

> **💡 Quick Model Recommendations:**
> - **For Image Understanding / Vision Tasks**: Switch to `/model qwen3.5`, `/model gemma`, or `/model ministral`.
> - **For Agentic Planning & Multi-Step Workflows**: Switch to `/model fable` (Parable Fable 4B).
> - **For Deep Coding & Reasoning**: Switch to `/model granite` or `/model qwen3.5`.
> - **For Fast Tool Execution & Low Latency**: Switch to `/model ministral` or `/model lfm`.

---

### 📷 2. Multimodal Vision Input (`/image`)
- **Native Vision Models**: Seamlessly inspect and analyze images with `qwen3.5:4b`, `gemma3-tools:4b`, and `ministral-3:3b`.
- **Automatic Base64 Encoding**: Automatically encodes `.png`, `.jpg`, `.jpeg`, `.webp`, and `.svg` files into standard multimodal context blocks.
- **REPL & CLI Usage**:
  ```bash
  # In interactive REPL:
  /image path/to/diagram.png Explain the architecture in this diagram

  # In single-shot CLI:
  bun app/main.ts -m qwen3.5 --image screenshot.png -p "Convert this UI layout into a React component"
  ```

---

### 🧠 3. Claude Code Style Live Thinking Stream
- **Real-Time Intent Stages**: As reasoning models deliberate, a single-line status transitions through live cognitive phases:
  - `⠋ Thinking (1.2s)...` ➔ `⠹ Analyzing approach (3.4s)...` ➔ `⠼ Synthesizing steps (8.5s)...` ➔ `⠸ Finalizing response (18.1s)...`
- **Clean Collapse**: Cleanly collapses to `✨ Thought for 3.1s` before streaming the final response text.
- **Configurable Reasoning Depth**: Toggle reasoning depth via `--thinking low` / `/thinking low` for **5x faster completions** or `--thinking off` for instant direct answers.

---

### 🎨 4. Rich Terminal Markdown Streaming
- **Live Line-Buffered Renderer**:
  - Converts raw markdown into styled ANSI terminal typography in real-time.
  - Formats **headers**, **bold text**, **bullet lists**, **numbered steps**, **blockquotes**, and **tables**.
  - Renders **syntax-highlighted code blocks** inside framed ASCII boxes (`┌── typescript ──┐`).

---

### 🖥️ 5. Enhanced REPL User Experience
- **Tab-Completion**: Press `Tab` after `/` for instant autocomplete across all built-in commands and custom scripts from `.agents/commands/`.
- **Rich Status Line in Prompt**:
  ```text
  [qwen3.5 · default · think:off · db:tbx_finance · ctx:8%] you ❯
  ```
  Every prompt displays active model shortname, active persona, reasoning depth, connected database, and real-time context token usage percentage.
- **Proactive Context Warning**: Displays an auto-compact notification whenever session context approaches 75% capacity, prompting you to `/compact`.
- **Clean `/history`**: Shows the last 10 conversational turns with 240-character previews, filtering out system instructions and tool telemetry.

---

### 🌍 6. System & Environment Awareness (`inspect`)
- Complete hardware and telemetry inspection with hardware-aware model orchestration:
  - **`inspect("models")`**: Lists all local models, vision support flags, VRAM requirements, and switch aliases.
  - **`inspect("project")`**: Single-shot introspection of languages, frameworks, linters, package managers, and git status.
  - **`inspect("hardware")`**: OS, CPU, dedicated GPU (e.g. RTX 3050 Laptop), available VRAM, RAM, and recommended model.
  - **`inspect("file", path)` & `inspect("directory", path)`**: Line counts, file size, extension breakdowns, and previews.
  - **`inspect("process")` & `inspect("config")`**: Process uptime, heap/RSS memory, active model, hooks, and security policies.

---

### 🧹 7. Project Garbage Collector & Codebase Entropy Engine (`/entropy` & `DeadCodeScan`)
- A dedicated cleaner organ that discovers everything nobody uses anymore:
  - **Unused Dependencies**: Scans `package.json` against all project imports.
  - **Dead / Orphan Exports**: Pinpoints exported functions, types, and constants with 0 consumers outside their declaring file.
  - **Orphaned Source Files**: Finds code files that are never imported anywhere.
  - **Stale Environment Variables**: Identifies `.env` keys never referenced in code.
  - **Project Entropy Score**: Calculates overall codebase entropy percentage (e.g. `12% [🟢 Clean]`) with actionable cleanup instructions.
  - **REPL Slash Command**: Type `/entropy` or `/gc` in the interactive terminal for an instant codebase health audit.

---

### 🧅 8. Request & Response Middleware Pipeline (`.agents/middleware/`)
- Intercepts and mutates the live request/response stream:
  ```text
  User Prompt ➔ [Middleware 1] ➔ [Middleware 2] ➔ Model ➔ [Middleware 2] ➔ [Middleware 1] ➔ Response
  ```
- **Capabilities**:
  - **`beforeRequest(ctx)`**: Inspect, mutate, or enrich `prompt`, `messages`, `tools`, `modelParams`, or **short-circuit** response without hitting the LLM.
  - **`afterResponse(ctx)`**: Clean, format, sanitize, redact API keys/secrets, or transform model outputs.
  - **Onion Execution Order**: Lower priority executes first on incoming requests and last on outgoing responses.
  - **REPL Slash Command**: Type `/middleware` in the terminal to inspect all active interceptors.

---

### 🔄 9. Explicit Agent Lifecycle State Machine (`app/state-machine.ts`)
- Gives the agent an explicit, deterministic state lifecycle:
  ```text
  IDLE ➔ UNDERSTANDING ➔ PLANNING ➔ EXECUTING ➔ VERIFYING ➔ WAITING ➔ COMPLETED
  ```
- **Capabilities**:
  - **State Ownership**: Owns agent state and validates state transitions (`onEnter`, `onExit`, `onTransition`).
  - **Subsystem Subscriptions**: UI, Telemetry, Permissions, Hooks, and JSON-RPC servers subscribe to `state.changed` transitions.
  - **Dwell Time & Transition Tracing**: Tracks exact dwell times per state for deep performance profiling.
  - **REPL Slash Command**: Type `/state` or `/lifecycle` in the terminal to inspect the active state and lifecycle transition timeline.

---

### 🧠 10. Autonomous Evaluator & Self-Improvement Engine (`app/evaluators.ts`)
- Independent scoring organ that judges output quality and provides actionable critique:
  - **`CodeEvaluator`** (weight 0.25): Detects unexecuted tool JSON leaks, unclosed code fences, and empty answers.
  - **`SecurityEvaluator`** (weight 0.25): Inspects for exposed API keys (`ghp_`, `sk-`), tokens, and destructive shell commands (`rm -rf`).
  - **`TaskEvaluator`** (weight 0.30): Validates prompt intent, file modifications, and requested item counts.
  - **`StyleEvaluator`** (weight 0.20): Strips leftover `<think>` tags and conversational fluff.
- **Model Tool & Slash Command**:
  - **Tool**: `EvaluateOutput(output)` for autonomous LLM reflection.
  - **Slash Command**: `/eval` or `/judge` in the REPL terminal to score the latest assistant response.

---

### 🗜️ 11. Context Compression & Low-VRAM Summarization Engine
- Tailored for low-memory local models (3B / 4B / 8B) and tight VRAM limits:
  - **`extract_symbols(filePath)`**: Extracts function signatures, classes, interfaces, and types without loading full bodies (up to **95% token savings**).
  - **`summarize_file(filePath)`**: Generates a high-level compressed skeleton, dependencies, and structural outline.
  - **`context_extract(filePath, query, radius)`**: Slices a focused window around a target function or keyword with custom radius.
  - **`summarize_diff(filePath)`**: Returns compact statistics and functional summaries of uncommitted git diffs.
  - **`compress_history(messages)`**: Intelligently digests older turns into a structured summary when approaching context limits.

---

### 🧰 12. On-Demand Tool Discovery & Progressive Context Loading
- Avoids dumping dozens of tool schemas into every prompt payload:
  - **Lean Core Toolset**: Initially activates only high-leverage core primitives (`Inspect`, `Read`, `Write`, `Edit`, `Tree`, `Find`, `Grep`, `Bash`, `Calculator`, `Weather`, `ToolSearch`, `ToolsAvailable`).
  - **`ToolsAvailable()`**: Lists available catalogs across categories without loading their JSON schemas into prompt context.
  - **`ToolSearch("query")`**: Dynamically searches and hot-loads specialized capabilities (`WebSearch`, LSP symbol tools, custom database tools, or MCP servers) on-demand.

---

### 🗂️ 13. Specialized Filesystem Intelligence Tools
- Native, token-efficient tools so the LLM doesn't rely on raw Bash commands for every inspection:
  - **`Edit`**: First-class structural code modification (`replace`, `insert_after`, `insert_before`, `delete`, `append`, `prepend`) with AST syntax protection.
  - **`Tree`**: Structured, depth-limited ASCII directory hierarchy (e.g. `tree("src/", 2)`).
  - **`Find`**: Instant filename & substring finder (e.g. `find("package.json")`).
  - **`Glob`**: Fast glob pattern matching across projects (e.g. `glob("src/**/*.ts")`).
  - **`Grep`**: Content regex/keyword search with exact line numbers (e.g. `grep("TODO", "src/")`).

---

### 🔌 14. Multi-Engine Database Connector (`/db`)
- Seamless database management across SQLite, PostgreSQL, and MySQL:
  - **Connection Profiles**: Manage profiles in `.agents/connections.json`.
  - **Schema Exploration**: Introspect tables, schemas, and query execution plans directly from REPL:
    ```text
    /db list
    /db use <profile>
    /db tables
    /db schema <table_name>
    /db test
    ```

---

## 🚀 Quickstart Guide

### 📦 Prerequisites
- **[Bun](https://bun.sh)** (v1.1+ recommended)
- **[Ollama](https://ollama.com)** running locally with your desired models:
  ```bash
  ollama pull granite4.2:3b
  ollama pull qwen3.5:4b
  ollama pull PetrosStav/gemma3-tools:4b
  ollama pull ministral-3:3b
  ollama pull lfm2.5:8b
  ```

### 🛠️ Installation
```bash
git clone https://github.com/Snaehath/ai-coding-agent.git
cd ai-coding-agent
bun install
```

Configure environment variables in `.env`:
```env
OPENROUTER_API_KEY="ollama"
OPENROUTER_BASE_URL="http://localhost:11434/v1"
MODEL="granite4.2:3b"
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
| `/models` | List all installed local models, vision support & VRAM |
| `/model [alias]` | Switch AI model (or interactive selector if empty) |
| `/thinking [low\|high\|off]` | Adjust chain-of-thought reasoning depth |
| `/image <path> [prompt]` | Attach an image file for vision models (`qwen3.5`, `gemma`, `ministral`) |
| `/history` | View clean conversation history (skipping system/tool noise) |
| `/compact` | Compress conversation history to save tokens |
| `/stats` | Display real-time session telemetry & context budget |
| `/db [cmd]` | Database connector (`list`, `use`, `tables`, `schema`, `test`) |
| `/entropy` \| `/gc` | Codebase health audit (unused deps, dead exports, stale env) |
| `/middleware` | Inspect active request & response interceptors |
| `/state` | View agent lifecycle state machine & dwell times |
| `/eval` \| `/judge` | Self-critique and score the latest assistant response |
| `/skills` | List active agent skills |
| `/permissions` | Inspect active permission security policies |
| `/hooks` | Inspect active lifecycle hooks |
| `/sessions` | List saved sessions |
| `/clear` | Start a fresh session |
| `/exit` | Quit the agent |

---

### ⚡ 2. Single-Prompt CLI Mode (`-p`)
Run one-off prompts directly in your terminal:

```bash
# Vision & UI inspection with Qwen 3.5
bun app/main.ts -m qwen3.5 --image screenshot.png -p "Explain the UI layout and suggest improvements"

# Deep reasoning with Granite 4.2
bun app/main.ts -m granite --thinking high -p "Design a high-throughput event queue in TypeScript"

# Fast reasoning with Granite (low effort)
bun app/main.ts -m granite --thinking low -p "Explain the producer-consumer pattern with an example"

# Multimodal image analysis with Gemma 3
bun app/main.ts -m gemma --image architecture.png -p "Describe this architecture diagram"

# Fast tool execution with Ministral
bun app/main.ts -m ministral -p "Audit package.json and report outdated dependencies"
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

## 🤝 Roadmap & Future Explorations

Here are some areas currently being explored:
- [ ] **Unified Diff & Patch Editing**: Smarter AST/diff-based file editing for large codebases.
- [ ] **Multi-Agent Swarm Mode**: Specialized subagents (Planner, Architect, Coder, Reviewer, Tester).
- [ ] **Background Watcher / Daemon Mode**: Autonomous test-driven repair on file save.
- [ ] **VS Code & Web UI Companion**: Lightweight sidecar extension connecting to `app/server.ts`.
