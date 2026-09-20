# BrAIn Browser

BrAIn Browser is a private desktop explorer for files created by local AI tools. It detects supported desktop applications, coding agents, editor extensions, and CLIs; groups artifacts by purpose; and lets you safely preview, copy, export, refresh, or move files to the operating system trash.

## Privacy and safety

- All discovery and preview work happens locally.
- The app has no telemetry and makes no artifact-content network requests.
- Built-in providers are limited to their documented configuration roots.
- Browser-profile storage is not scanned.
- Embedded WebView browser-profile folders are excluded from Microsoft Copilot package scans.
- Chromium browser-profile and cache folders are excluded from Claude Desktop scans.
- Custom folders are scanned only after the user selects them.
- Artifact paths are canonicalized and constrained to an approved root.
- Delete actions require confirmation and use Recycle Bin on Windows or Trash on macOS.
- Markdown does not execute embedded HTML or scripts.

## Supported providers

| Provider | Default root | Override |
| --- | --- | --- |
| GitHub Copilot CLI | `~/.copilot` plus its platform cache directory | `COPILOT_HOME`, `COPILOT_CACHE_HOME` |
| GitHub Copilot in VS Code | VS Code chat-session and installed Copilot extension roots | VS Code user-data and extension overrides |
| Microsoft Copilot | Detected Windows package and local app-data roots; known macOS container and support roots | None documented |
| Microsoft 365 Copilot | `Microsoft.MicrosoftOfficeHub` package data on Windows; known macOS container and support roots | None documented |
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Claude Desktop | `%APPDATA%\Claude`, `%LOCALAPPDATA%\Claude`, `%LOCALAPPDATA%\Claude-3p`, packaged `LocalCache\Roaming\Claude` data, and user output folders on Windows; known support, logs, managed-data, and output roots on macOS | None documented |
| OpenAI | Codex `~/.codex` storage plus dynamically detected ChatGPT Desktop package/container roots | `CODEX_HOME` for shared Codex storage |
| Perplexity / Comet | Dynamically detected Windows package roots; known macOS containers | None documented |
| Gemini CLI | `~/.gemini` | `GEMINI_CLI_HOME` |
| Continue | `~/.continue` | `CONTINUE_GLOBAL_DIR` |
| Cursor | Platform user-data and extension roots | App launch arguments may relocate data |
| Windsurf | Platform user-data, Codeium data, and extension roots | App launch arguments may relocate data |
| Cline | Cline global storage in VS Code, Cursor, and Windsurf | Host editor user-data overrides |

Provider layouts can change between tool releases. BrAIn Browser classifies plans, sessions, memories, prompts, logs, credentials, caches, databases, configuration files, and images, and leaves unmatched files visible under **Other**. Proprietary, encrypted, SQLite, and LevelDB artifacts remain visible but may provide metadata-only previews. Microsoft Copilot conversation history is primarily account-backed and might not exist as a readable local transcript.

## Browsing capabilities

- Detects known MCP configuration filenames and bounded `mcpServers` signatures, grouped under **MCP Configuration**.
- Displays MCP configuration contents using the formatted JSON, YAML, TOML, or text viewer.
- Sorts artifacts by newest, name, size, or type.
- Shows file-format badges and distinct icons for documents, databases, archives, binaries, images, and opaque stores.
- Displays absolute paths and detailed metadata for unsupported files.
- Reveals the selected artifact in File Explorer on Windows or Finder on macOS.
- Provides likely-role summaries for session, memory, history, cache, state, and database artifacts without claiming to decode proprietary schemas.
- Supports explicit Edit mode for safe UTF-8 text artifacts. Save activates only after a change and rejects stale writes when another application changed the file.
- Opens all artifact category groups collapsed for a compact initial view.
- Hides zero-byte artifacts from the second-panel file list by default, with a **Hide 0KB files** checkbox to reveal them.
- Hides non-text artifacts and Python source files from the second-panel file list by default, with a **Hide non-text and code files** checkbox to reveal them.
- Keeps the application list in the first panel independently scrollable while its heading and privacy footer remain visible.
- Gives JSONL session files a **Prompt History** view that recognizes common Copilot, Claude, Codex, and generic user-message records, orders prompts newest-first, and retains a Raw JSONL tab.
- Displays CSV files as scrollable tables with header rows, row numbers, quoted-field handling, and bounded rendering.
- Separates transcript, event, history, and session-database files into **Session Logs**, while other files beneath session roots appear under **Other Session Artifacts** unless they match a more specific category.
- Adds **Prompt Timeline** above the application list, aggregating recognized prompts from every approved local JSONL provider root into one searchable, provider-filterable, newest-first view.
- Provides a per-prompt copy button in **Prompt Timeline** with visible success or failure feedback.
- Filters assistant, model, tool, system, function, execution, and tool-result events from prompt views even when those records carry copied user-context fields.
- Understands structured Claude Code content blocks, excluding protocol-level `user` messages that contain only tool results while preserving genuine text blocks and pasted code prompts.

## Development

Prerequisites:

- Node.js 20 or newer
- Rust stable
- Tauri 2 platform prerequisites

```powershell
npm install
npm run tauri dev
```

Validation:

```powershell
npm run build
cargo fmt --manifest-path .\src-tauri\Cargo.toml -- --check
cargo test --manifest-path .\src-tauri\Cargo.toml
```

Create release bundles:

```powershell
npm run tauri build
```

Windows builds produce installer artifacts under `src-tauri\target\release\bundle`. macOS builds must run on macOS to produce `.app` and `.dmg` bundles.
