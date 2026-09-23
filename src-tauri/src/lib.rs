use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{hash_map::DefaultHasher, HashSet},
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};
use tauri::{AppHandle, Manager, State};
use walkdir::{DirEntry, WalkDir};

const MAX_ARTIFACTS: usize = 10_000;
const MAX_PREVIEW_BYTES: u64 = 1_048_576;
const MAX_IMAGE_BYTES: u64 = 10_485_760;
const MAX_TITLE_BYTES: u64 = 65_536;
const MAX_TIMELINE_FILES: usize = 5_000;
const MAX_TIMELINE_PROMPTS: usize = 50_000;

fn window_title(version: &str) -> String {
    format!("BrAIn Browser v{version}")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactSource {
    id: String,
    provider_id: String,
    provider_name: String,
    name: String,
    root: String,
    available: bool,
    is_custom: bool,
    artifact_count: usize,
    #[serde(skip)]
    roots: Vec<SourceRoot>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ScanPolicy {
    All,
    ClaudeDesktop,
}

#[derive(Clone)]
struct SourceRoot {
    key: String,
    path: PathBuf,
    scan_policy: ScanPolicy,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactEntry {
    relative_path: String,
    absolute_path: String,
    name: String,
    extension: Option<String>,
    json_format: Option<String>,
    category: String,
    artifact_kind: String,
    size: u64,
    created_at: Option<u64>,
    modified_at: u64,
    content_title: String,
    preview_kind: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPreview {
    kind: String,
    content: Option<String>,
    data_url: Option<String>,
    truncated: bool,
    warning: Option<String>,
    editable: bool,
    revision: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelinePrompt {
    text: String,
    timestamp_ms: Option<i64>,
    timestamp_inferred: bool,
    provider_id: String,
    provider_name: String,
    session_id: String,
    source_path: String,
    #[serde(skip)]
    source_order: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptTimeline {
    prompts: Vec<TimelinePrompt>,
    scanned_files: usize,
    malformed_records: usize,
    truncated: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    custom_folders: Vec<CustomFolder>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomFolder {
    id: String,
    name: String,
    root: PathBuf,
}

struct AppState {
    settings: Mutex<Settings>,
    settings_path: PathBuf,
}

struct Provider {
    id: &'static str,
    name: &'static str,
}

const PROVIDERS: [Provider; 13] = [
    Provider {
        id: "copilot",
        name: "GitHub Copilot CLI",
    },
    Provider {
        id: "copilot-vscode",
        name: "GitHub Copilot in VS Code",
    },
    Provider {
        id: "microsoft-copilot",
        name: "Microsoft Copilot",
    },
    Provider {
        id: "microsoft-365-copilot",
        name: "Microsoft 365 Copilot",
    },
    Provider {
        id: "claude-code",
        name: "Claude Code",
    },
    Provider {
        id: "claude-desktop",
        name: "Claude Desktop",
    },
    Provider {
        id: "openai",
        name: "OpenAI",
    },
    Provider {
        id: "perplexity",
        name: "Perplexity / Comet",
    },
    Provider {
        id: "gemini",
        name: "Gemini CLI",
    },
    Provider {
        id: "continue",
        name: "Continue",
    },
    Provider {
        id: "cursor",
        name: "Cursor",
    },
    Provider {
        id: "windsurf",
        name: "Windsurf",
    },
    Provider {
        id: "cline",
        name: "Cline",
    },
];

fn source_id(provider_id: &str, root: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    provider_id.hash(&mut hasher);
    root.hash(&mut hasher);
    format!("{provider_id}-{:x}", hasher.finish())
}

fn built_in_source_id(provider_id: &str, _display_root: &Path) -> String {
    provider_id.to_string()
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("settings.json"))
        .map_err(|error| format!("Could not resolve the settings directory: {error}"))
}

fn load_settings(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_settings(state: &AppState, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = state.settings_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the settings directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    fs::write(&state.settings_path, content)
        .map_err(|error| format!("Could not save settings: {error}"))
}

fn add_root(roots: &mut Vec<SourceRoot>, key: impl Into<String>, path: Option<PathBuf>) {
    add_root_with_policy(roots, key, path, ScanPolicy::All);
}

fn add_root_with_policy(
    roots: &mut Vec<SourceRoot>,
    key: impl Into<String>,
    path: Option<PathBuf>,
    scan_policy: ScanPolicy,
) {
    let Some(path) = path else {
        return;
    };
    if roots.iter().any(|root| root.path == path) {
        return;
    }
    roots.push(SourceRoot {
        key: key.into(),
        path,
        scan_policy,
    });
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn matching_child_directories(parent: &Path, predicate: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter(|entry| predicate(&entry.file_name().to_string_lossy().to_ascii_lowercase()))
        .map(|entry| entry.path())
        .collect()
}

fn vscode_chat_roots(user_data: &Path) -> Vec<(String, PathBuf)> {
    let user = user_data.join("User");
    let mut roots = Vec::new();
    let empty_sessions = user.join("globalStorage").join("emptyWindowChatSessions");
    if empty_sessions.is_dir() {
        roots.push(("empty-window-chats".to_string(), empty_sessions));
    }
    let workspace_storage = user.join("workspaceStorage");
    if let Ok(entries) = fs::read_dir(workspace_storage) {
        for entry in entries.flatten().take(1_000) {
            let chats = entry.path().join("chatSessions");
            if chats.is_dir() {
                roots.push((format!("workspace-{}", roots.len() + 1), chats));
            }
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn installed_package_roots(keywords: &[&str]) -> Vec<PathBuf> {
    let Some(packages) = dirs::data_local_dir().map(|path| path.join("Packages")) else {
        return Vec::new();
    };
    matching_child_directories(&packages, |name| {
        keywords.iter().any(|keyword| name.starts_with(keyword))
    })
}

#[cfg(not(target_os = "windows"))]
fn installed_package_roots(_keywords: &[&str]) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(target_os = "windows")]
fn claude_desktop_windows_roots(
    home: &Path,
    config: Option<&Path>,
    local: Option<&Path>,
    package_roots: Vec<PathBuf>,
) -> Vec<SourceRoot> {
    let mut roots = Vec::new();
    add_root_with_policy(
        &mut roots,
        "desktop-roaming",
        config.map(|path| path.join("Claude")),
        ScanPolicy::ClaudeDesktop,
    );
    add_root_with_policy(
        &mut roots,
        "desktop-local",
        local.map(|path| path.join("Claude")),
        ScanPolicy::ClaudeDesktop,
    );
    add_root_with_policy(
        &mut roots,
        "managed",
        local.map(|path| path.join("Claude-3p")),
        ScanPolicy::ClaudeDesktop,
    );
    add_root_with_policy(
        &mut roots,
        "managed-legacy",
        config.map(|path| path.join("Claude-3p")),
        ScanPolicy::ClaudeDesktop,
    );
    add_root(&mut roots, "outputs", Some(home.join("Claude")));
    add_root(
        &mut roots,
        "outputs-legacy",
        Some(home.join("Documents").join("Claude")),
    );
    for (index, package) in package_roots.into_iter().enumerate() {
        add_root_with_policy(
            &mut roots,
            format!("package-{}", index + 1),
            Some(package.join("LocalCache").join("Roaming").join("Claude")),
            ScanPolicy::ClaudeDesktop,
        );
    }
    roots
}

fn provider_roots(provider_id: &str, home: &Path) -> Vec<SourceRoot> {
    let config = dirs::config_dir();
    let local = dirs::data_local_dir();
    let mut roots = Vec::new();

    match provider_id {
        "copilot" => {
            add_root(
                &mut roots,
                "files",
                env_path("COPILOT_HOME").or_else(|| Some(home.join(".copilot"))),
            );
            add_root(
                &mut roots,
                "cache",
                env_path("COPILOT_CACHE_HOME").or_else(|| default_copilot_cache(home)),
            );
        }
        "copilot-vscode" => {
            for host in ["Code", "Code - Insiders"] {
                if let Some(code_root) = config.as_ref().map(|path| path.join(host)) {
                    for (key, path) in vscode_chat_roots(&code_root) {
                        add_root(&mut roots, format!("{host}-{key}"), Some(path));
                    }
                }
            }
            for (index, extension) in
                matching_child_directories(&home.join(".vscode").join("extensions"), |name| {
                    name.starts_with("github.copilot")
                })
                .into_iter()
                .enumerate()
            {
                add_root(
                    &mut roots,
                    format!("extension-{}", index + 1),
                    Some(extension),
                );
            }
            #[cfg(target_os = "macos")]
            add_root(
                &mut roots,
                "xcode-logs",
                Some(home.join("Library").join("Logs").join("GitHubCopilot")),
            );
        }
        "microsoft-copilot" => {
            #[cfg(target_os = "windows")]
            {
                for (index, package) in
                    installed_package_roots(&["microsoft.copilot", "microsoft.aicopilot"])
                        .into_iter()
                        .enumerate()
                {
                    add_root(&mut roots, format!("package-{}", index + 1), Some(package));
                }
                add_root(
                    &mut roots,
                    "local",
                    local
                        .as_ref()
                        .map(|path| path.join("Microsoft").join("Copilot")),
                );
            }
            #[cfg(target_os = "macos")]
            {
                add_root(
                    &mut roots,
                    "container",
                    Some(
                        home.join("Library")
                            .join("Containers")
                            .join("com.microsoft.copilot"),
                    ),
                );
                add_root(
                    &mut roots,
                    "support",
                    Some(
                        home.join("Library")
                            .join("Application Support")
                            .join("Microsoft")
                            .join("Copilot"),
                    ),
                );
            }
        }
        "microsoft-365-copilot" => {
            #[cfg(target_os = "windows")]
            for (index, package) in installed_package_roots(&["microsoft.microsoftofficehub"])
                .into_iter()
                .enumerate()
            {
                add_root(&mut roots, format!("package-{}", index + 1), Some(package));
            }
            #[cfg(target_os = "macos")]
            {
                add_root(
                    &mut roots,
                    "container",
                    Some(
                        home.join("Library")
                            .join("Containers")
                            .join("com.microsoft.copilot"),
                    ),
                );
                add_root(
                    &mut roots,
                    "support",
                    Some(
                        home.join("Library")
                            .join("Application Support")
                            .join("Microsoft 365 Copilot"),
                    ),
                );
            }
        }
        "claude-code" => add_root(
            &mut roots,
            "files",
            env_path("CLAUDE_CONFIG_DIR").or_else(|| Some(home.join(".claude"))),
        ),
        "claude-desktop" => {
            #[cfg(target_os = "windows")]
            roots.extend(claude_desktop_windows_roots(
                home,
                config.as_deref(),
                local.as_deref(),
                installed_package_roots(&["claude"]),
            ));
            #[cfg(target_os = "macos")]
            {
                add_root_with_policy(
                    &mut roots,
                    "desktop",
                    config.as_ref().map(|path| path.join("Claude")),
                    ScanPolicy::ClaudeDesktop,
                );
                add_root_with_policy(
                    &mut roots,
                    "managed",
                    local.as_ref().map(|path| path.join("Claude-3p")),
                    ScanPolicy::ClaudeDesktop,
                );
                add_root_with_policy(
                    &mut roots,
                    "managed-legacy",
                    config.as_ref().map(|path| path.join("Claude-3p")),
                    ScanPolicy::ClaudeDesktop,
                );
                add_root(&mut roots, "outputs", Some(home.join("Claude")));
                add_root(
                    &mut roots,
                    "outputs-legacy",
                    Some(home.join("Documents").join("Claude")),
                );
                add_root_with_policy(
                    &mut roots,
                    "logs",
                    Some(home.join("Library").join("Logs").join("Claude")),
                    ScanPolicy::ClaudeDesktop,
                );
                add_root_with_policy(
                    &mut roots,
                    "managed-logs",
                    Some(home.join("Library").join("Logs").join("Claude-3p")),
                    ScanPolicy::ClaudeDesktop,
                );
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                add_root_with_policy(
                    &mut roots,
                    "desktop",
                    config.as_ref().map(|path| path.join("Claude")),
                    ScanPolicy::ClaudeDesktop,
                );
                add_root_with_policy(
                    &mut roots,
                    "managed",
                    local.as_ref().map(|path| path.join("Claude-3p")),
                    ScanPolicy::ClaudeDesktop,
                );
                add_root(&mut roots, "outputs", Some(home.join("Claude")));
                add_root(
                    &mut roots,
                    "outputs-legacy",
                    Some(home.join("Documents").join("Claude")),
                );
            }
        }
        "openai" => {
            add_root(
                &mut roots,
                "codex",
                env_path("CODEX_HOME").or_else(|| Some(home.join(".codex"))),
            );
            #[cfg(target_os = "windows")]
            {
                for (index, package) in installed_package_roots(&["chatgpt", "openai.chatgpt"])
                    .into_iter()
                    .enumerate()
                {
                    add_root(&mut roots, format!("package-{}", index + 1), Some(package));
                }
            }
            #[cfg(target_os = "macos")]
            {
                add_root(
                    &mut roots,
                    "legacy",
                    Some(
                        home.join("Library")
                            .join("Application Support")
                            .join("com.openai.chat"),
                    ),
                );
                add_root(
                    &mut roots,
                    "container",
                    Some(
                        home.join("Library")
                            .join("Containers")
                            .join("com.openai.codex"),
                    ),
                );
            }
        }
        "perplexity" => {
            #[cfg(target_os = "windows")]
            {
                for (index, package) in installed_package_roots(&["perplexity", "comet"])
                    .into_iter()
                    .enumerate()
                {
                    add_root(&mut roots, format!("package-{}", index + 1), Some(package));
                }
            }
            #[cfg(target_os = "macos")]
            {
                add_root(
                    &mut roots,
                    "comet-container",
                    Some(
                        home.join("Library")
                            .join("Containers")
                            .join("ai.perplexity.comet"),
                    ),
                );
                add_root(
                    &mut roots,
                    "perplexity",
                    Some(
                        home.join("Library")
                            .join("Application Support")
                            .join("Perplexity"),
                    ),
                );
                add_root(
                    &mut roots,
                    "comet",
                    Some(
                        home.join("Library")
                            .join("Application Support")
                            .join("Comet"),
                    ),
                );
            }
        }
        "gemini" => {
            let root = env_path("GEMINI_CLI_HOME")
                .map(|path| path.join(".gemini"))
                .unwrap_or_else(|| home.join(".gemini"));
            add_root(&mut roots, "files", Some(root));
        }
        "continue" => add_root(
            &mut roots,
            "files",
            env_path("CONTINUE_GLOBAL_DIR").or_else(|| Some(home.join(".continue"))),
        ),
        "cursor" => {
            add_root(
                &mut roots,
                "cursor",
                config.as_ref().map(|path| path.join("Cursor")),
            );
            add_root(
                &mut roots,
                "cursor-insiders",
                config.as_ref().map(|path| path.join("Cursor - Insiders")),
            );
            add_root(
                &mut roots,
                "cursor-extensions",
                Some(home.join(".cursor").join("extensions")),
            );
        }
        "windsurf" => {
            add_root(
                &mut roots,
                "windsurf",
                config.as_ref().map(|path| path.join("Windsurf")),
            );
            add_root(
                &mut roots,
                "windsurf-data",
                Some(home.join(".codeium").join("windsurf")),
            );
            add_root(
                &mut roots,
                "windsurf-extensions",
                Some(home.join(".windsurf").join("extensions")),
            );
        }
        "cline" => {
            for (key, host) in [
                ("vscode", "Code"),
                ("vscode-insiders", "Code - Insiders"),
                ("cursor", "Cursor"),
                ("cursor-insiders", "Cursor - Insiders"),
                ("windsurf", "Windsurf"),
            ] {
                let Some(host_root) = config.as_ref().map(|path| path.join(host)) else {
                    continue;
                };
                add_root(
                    &mut roots,
                    key,
                    Some(
                        host_root
                            .join("User")
                            .join("globalStorage")
                            .join("saoudrizwan.claude-dev"),
                    ),
                );
            }
        }
        _ => {}
    }
    roots
}

fn approved_sources(
    state: &AppState,
    include_artifact_counts: bool,
) -> Result<Vec<ArtifactSource>, String> {
    let home = dirs::home_dir().ok_or("Could not resolve the current user's home directory.")?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are temporarily unavailable.")?
        .clone();
    let mut sources = PROVIDERS
        .iter()
        .map(|provider| {
            let roots = provider_roots(provider.id, &home);
            let display_root = roots
                .iter()
                .find(|root| root.path.is_dir())
                .or_else(|| roots.first())
                .map(|root| root.path.clone())
                .unwrap_or_else(|| home.join(format!(".{}", provider.id)));
            let available = roots.iter().any(|candidate| candidate.path.is_dir());
            let artifact_count = if include_artifact_counts {
                roots
                    .iter()
                    .map(|candidate| count_artifacts(&candidate.path, candidate.scan_policy))
                    .sum()
            } else {
                0
            };
            ArtifactSource {
                id: built_in_source_id(provider.id, &display_root),
                provider_id: provider.id.to_string(),
                provider_name: provider.name.to_string(),
                name: provider.name.to_string(),
                root: display_root.to_string_lossy().into_owned(),
                available,
                is_custom: false,
                artifact_count,
                roots,
            }
        })
        .collect::<Vec<_>>();

    sources.extend(settings.custom_folders.into_iter().map(|folder| {
        let available = folder.root.is_dir();
        ArtifactSource {
            id: folder.id,
            provider_id: "custom".to_string(),
            provider_name: "Custom folder".to_string(),
            name: folder.name,
            root: folder.root.to_string_lossy().into_owned(),
            available,
            is_custom: true,
            artifact_count: if include_artifact_counts {
                count_artifacts(&folder.root, ScanPolicy::All)
            } else {
                0
            },
            roots: vec![SourceRoot {
                key: "files".to_string(),
                path: folder.root,
                scan_policy: ScanPolicy::All,
            }],
        }
    }));
    sources.sort_by(|a, b| {
        b.available
            .cmp(&a.available)
            .then_with(|| a.provider_name.cmp(&b.provider_name))
    });
    Ok(sources)
}

fn default_copilot_cache(_home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return dirs::data_local_dir().map(|path| path.join("copilot"));
    }
    #[cfg(target_os = "macos")]
    {
        return Some(_home.join("Library").join("Caches").join("copilot"));
    }
    #[allow(unreachable_code)]
    None
}

fn is_hidden_noise(entry: &DirEntry) -> bool {
    matches!(
        entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .as_str(),
        ".git" | "node_modules" | "target" | "__pycache__" | "ebwebview"
    )
}

fn is_claude_desktop_browser_noise(entry: &DirEntry) -> bool {
    matches!(
        entry
            .file_name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .as_str(),
        "blob_storage"
            | "cache"
            | "code cache"
            | "cookies"
            | "cookies-journal"
            | "crashpad"
            | "dawngraphitecache"
            | "dawnwebgpucache"
            | "dips"
            | "dips-wal"
            | "gpucache"
            | "grshadercache"
            | "history"
            | "history-journal"
            | "indexeddb"
            | "local state"
            | "local storage"
            | "login data"
            | "login data-journal"
            | "network"
            | "preferences"
            | "service worker"
            | "session storage"
            | "shadercache"
            | "shared dictionary"
            | "webstorage"
    )
}

fn artifact_files(root: &Path, scan_policy: ScanPolicy) -> impl Iterator<Item = DirEntry> {
    WalkDir::new(root)
        .max_depth(10)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |entry| {
            !is_hidden_noise(entry)
                && (!matches!(scan_policy, ScanPolicy::ClaudeDesktop)
                    || !is_claude_desktop_browser_noise(entry))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .take(MAX_ARTIFACTS)
}

fn count_artifacts(root: &Path, scan_policy: ScanPolicy) -> usize {
    if !root.is_dir() {
        return 0;
    }
    artifact_files(root, scan_policy).count()
}

fn classify(path: &Path) -> String {
    let normalized = path.to_string_lossy().to_ascii_lowercase();
    let segments = normalized
        .split(['/', '\\', '.', '_', '-'])
        .collect::<Vec<_>>();
    let contains = |needles: &[&str]| segments.iter().any(|part| needles.contains(part));
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if contains(&[
        "credential",
        "credentials",
        "auth",
        "oauth",
        "token",
        "tokens",
    ]) {
        "Credentials"
    } else if contains(&["agent", "agents", "subagent", "subagents"]) {
        "Agents"
    } else if contains(&["skill", "skills"]) {
        "Skills"
    } else if contains(&["extension", "extensions", "plugin", "plugins"]) {
        "Extensions & Plugins"
    } else if contains(&[
        "command",
        "commands",
        "hook",
        "hooks",
        "slashcommand",
        "slashcommands",
    ]) {
        "Commands & Hooks"
    } else if contains(&[
        "plan", "plans", "todo", "todos", "task", "tasks", "goal", "goals",
    ]) {
        "Plans"
    } else if contains(&["memory", "memories", "checkpoint", "checkpoints"]) {
        "Memories"
    } else if contains(&["rule", "rules", "instruction", "instructions"]) {
        "Rules & Instructions"
    } else if contains(&["prompt", "prompts"]) {
        "Prompts"
    } else if contains(&[
        "session",
        "sessions",
        "conversation",
        "conversations",
        "history",
    ]) {
        if matches!(
            extension.as_str(),
            "json" | "jsonl" | "log" | "db" | "sqlite" | "sqlite3"
        ) || [
            "event",
            "events",
            "transcript",
            "rollout",
            "history",
            "chat",
        ]
        .iter()
        .any(|marker| name.contains(marker))
        {
            "Session Logs"
        } else {
            "Other Session Artifacts"
        }
    } else if contains(&["log", "logs", "trace", "traces"]) {
        "Logs"
    } else if contains(&["cache", "caches", "cached"]) {
        "Caches"
    } else if contains(&["config", "settings", "preference", "preferences"]) {
        "Configuration"
    } else if matches!(extension.as_str(), "db" | "sqlite" | "sqlite3" | "ldb") {
        "Databases"
    } else if preview_kind(path) == "image" {
        "Images"
    } else {
        "Other"
    }
    .to_string()
}

fn is_mcp_configuration(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name.contains("mcp") || name == "claude_desktop_config.json" {
        return true;
    }
    if !matches!(extension.as_str(), "json" | "yaml" | "yml" | "toml") {
        return false;
    }
    if !name.contains("config") && !name.contains("settings") && !name.contains("preference") {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    if file.take(MAX_TITLE_BYTES).read_to_end(&mut bytes).is_err() {
        return false;
    }
    let content = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
    content.contains("\"mcpservers\"")
        || content.contains("mcpservers:")
        || content.contains("mcp_servers")
}

fn classify_entry(path: &Path, relative: &Path) -> String {
    if is_mcp_configuration(path) {
        "MCP Configuration".to_string()
    } else {
        classify(relative)
    }
}

fn artifact_kind(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let normalized = path.to_string_lossy().to_ascii_lowercase();
    if matches!(extension.as_str(), "db" | "sqlite" | "sqlite3" | "ldb")
        || normalized.contains("leveldb")
        || normalized.contains("indexeddb")
    {
        "database"
    } else if matches!(
        extension.as_str(),
        "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "asar"
    ) {
        "archive"
    } else if matches!(
        extension.as_str(),
        "exe" | "dll" | "dylib" | "so" | "bin" | "dat" | "pak"
    ) {
        "binary"
    } else {
        match preview_kind(path) {
            "image" => "image",
            "unsupported" => "opaque",
            _ => "document",
        }
    }
}

fn content_revision(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn is_editable_kind(path: &Path) -> bool {
    matches!(preview_kind(path), "text" | "markdown" | "json" | "yaml")
}

fn replace_text_file(
    path: &Path,
    expected_revision: &str,
    content: &str,
) -> Result<String, String> {
    if content.len() as u64 > MAX_PREVIEW_BYTES {
        return Err("Edited content exceeds the 1 MB text limit.".to_string());
    }
    let current =
        fs::read(path).map_err(|error| format!("Could not read the current artifact: {error}"))?;
    if current.len() as u64 > MAX_PREVIEW_BYTES
        || current.iter().take(8_192).any(|byte| *byte == 0)
        || std::str::from_utf8(&current).is_err()
    {
        return Err("This artifact is not safe to edit as UTF-8 text.".to_string());
    }
    if content_revision(&current) != expected_revision {
        return Err(
            "The artifact changed outside BrAIn Browser. Refresh it before saving.".to_string(),
        );
    }

    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not read artifact permissions: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "The artifact has no writable parent directory.".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Could not create a temporary save file: {error}"))?;
    temporary
        .as_file()
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("Could not preserve artifact permissions: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .and_then(|_| temporary.flush())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not write the updated artifact: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Could not replace the artifact: {}", error.error))?;
    Ok(content_revision(content.as_bytes()))
}

fn prompt_value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(prompt_value_text)
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        Value::Object(record) => {
            if let Some(block_type) = record.get("type").and_then(Value::as_str) {
                if !matches!(
                    block_type.to_ascii_lowercase().as_str(),
                    "text" | "input_text"
                ) {
                    return None;
                }
            }
            record
                .get("text")
                .or_else(|| record.get("content"))
                .and_then(prompt_value_text)
        }
        _ => None,
    }
}

fn record_value<'a>(
    record: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<&'a Value> {
    keys.iter().find_map(|key| record.get(*key))
}

fn timestamp_millis(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            let raw = number.as_f64()?;
            Some(if raw < 1_000_000_000_000.0 {
                (raw * 1_000.0) as i64
            } else {
                raw as i64
            })
        }
        Value::String(text) => {
            if let Ok(raw) = text.parse::<f64>() {
                return Some(if raw < 1_000_000_000_000.0 {
                    (raw * 1_000.0) as i64
                } else {
                    raw as i64
                });
            }
            DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|timestamp| timestamp.timestamp_millis())
        }
        _ => None,
    }
}

fn string_value(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
}

fn fallback_session_id(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Unknown session");
    if matches!(
        stem.to_ascii_lowercase().as_str(),
        "conversation"
            | "conversations"
            | "events"
            | "history"
            | "messages"
            | "prompts"
            | "session"
    ) {
        if let Some(parent) = path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
        {
            return parent.to_string();
        }
    }
    stem.to_string()
}

fn timeline_prompt_from_value(
    value: &Value,
    source: &ArtifactSource,
    path: &Path,
    fallback_timestamp_ms: Option<i64>,
) -> Option<TimelinePrompt> {
    let record = value.as_object()?;
    let nested = ["message", "data", "payload", "event"]
        .iter()
        .filter_map(|key| record.get(*key).and_then(Value::as_object))
        .collect::<Vec<_>>();
    let mut records = vec![record];
    records.extend(nested);

    let role_signals = records
        .iter()
        .flat_map(|candidate| {
            ["role", "type", "kind", "event_type", "eventType"]
                .iter()
                .filter_map(|key| candidate.get(*key).and_then(Value::as_str))
        })
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let is_user = role_signals.iter().any(|signal| {
        matches!(
            signal.as_str(),
            "user" | "human" | "user.message" | "user_message"
        ) || signal.contains("user-message")
    });
    let is_non_user = role_signals.iter().any(|signal| {
        matches!(
            signal.as_str(),
            "assistant" | "model" | "tool" | "system" | "function"
        ) || signal.starts_with("assistant.")
            || signal.starts_with("tool.")
            || signal.starts_with("system.")
            || signal.contains("tool-result")
            || signal.contains("tool_result")
            || signal.contains("execution")
    });
    let is_openai_history = record.get("text").and_then(Value::as_str).is_some()
        && record_value(record, &["session_id", "sessionId"]).is_some()
        && record_value(record, &["ts", "timestamp"]).is_some();
    if is_non_user && !is_user {
        return None;
    }
    let unambiguous_text =
        record_value(record, &["user_message", "userMessage"]).and_then(prompt_value_text);
    let user_role_text = if is_user {
        record_value(
            record,
            &["user_content", "userContent", "prompt", "content", "text"],
        )
        .and_then(prompt_value_text)
        .or_else(|| {
            records.iter().find_map(|candidate| {
                record_value(candidate, &["content", "text"]).and_then(prompt_value_text)
            })
        })
    } else {
        None
    };
    let openai_history_text = is_openai_history
        .then(|| record.get("text").and_then(prompt_value_text))
        .flatten();
    let text = unambiguous_text
        .or(user_role_text)
        .or(openai_history_text)?;
    if text.trim().is_empty() {
        return None;
    }

    let timestamp_ms = records.iter().find_map(|candidate| {
        record_value(
            candidate,
            &["timestamp", "ts", "created_at", "createdAt", "time"],
        )
        .and_then(timestamp_millis)
    });
    let session_id = records
        .iter()
        .find_map(|candidate| {
            record_value(
                candidate,
                &[
                    "session_id",
                    "sessionId",
                    "conversation_id",
                    "conversationId",
                    "thread_id",
                    "threadId",
                ],
            )
            .and_then(string_value)
        })
        .unwrap_or_else(|| fallback_session_id(path));

    Some(TimelinePrompt {
        text: text.trim().to_string(),
        timestamp_ms: timestamp_ms.or(fallback_timestamp_ms),
        timestamp_inferred: timestamp_ms.is_none() && fallback_timestamp_ms.is_some(),
        provider_id: source.provider_id.clone(),
        provider_name: source.provider_name.clone(),
        session_id,
        source_path: path.to_string_lossy().into_owned(),
        source_order: 0,
    })
}

fn collect_prompt_timeline(state: &AppState) -> Result<PromptTimeline, String> {
    let sources = approved_sources(state, false)?;
    let mut prompts = Vec::new();
    let mut scanned_files = 0;
    let mut malformed_records = 0;
    let mut truncated = false;
    let mut seen_files = HashSet::new();
    let mut source_order = 0;

    'sources: for source in sources.into_iter().filter(|source| source.available) {
        for root in source.roots.iter().filter(|root| root.path.is_dir()) {
            for entry in artifact_files(&root.path, root.scan_policy) {
                if entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| !value.eq_ignore_ascii_case("jsonl"))
                    .unwrap_or(true)
                {
                    continue;
                }
                if scanned_files >= MAX_TIMELINE_FILES {
                    truncated = true;
                    break 'sources;
                }
                let canonical = entry
                    .path()
                    .canonicalize()
                    .unwrap_or_else(|_| entry.path().to_path_buf());
                if !seen_files.insert(canonical) {
                    continue;
                }
                scanned_files += 1;
                let fallback_timestamp_ms = entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as i64);
                let Ok(file) = fs::File::open(entry.path()) else {
                    continue;
                };
                for line in BufReader::new(file).lines() {
                    if prompts.len() >= MAX_TIMELINE_PROMPTS {
                        truncated = true;
                        break 'sources;
                    }
                    let Ok(line) = line else {
                        malformed_records += 1;
                        continue;
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(value) => {
                            if let Some(mut prompt) = timeline_prompt_from_value(
                                &value,
                                &source,
                                entry.path(),
                                fallback_timestamp_ms,
                            ) {
                                source_order += 1;
                                prompt.source_order = source_order;
                                prompts.push(prompt);
                            }
                        }
                        Err(_) => malformed_records += 1,
                    }
                }
            }
        }
    }
    prompts.sort_by(|a, b| {
        b.timestamp_ms
            .unwrap_or_default()
            .cmp(&a.timestamp_ms.unwrap_or_default())
            .then_with(|| b.source_order.cmp(&a.source_order))
    });
    Ok(PromptTimeline {
        prompts,
        scanned_files,
        malformed_records,
        truncated,
    })
}

fn preview_kind(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "mdx" => "markdown",
        "json" | "jsonl" => "json",
        "yaml" | "yml" => "yaml",
        "txt" | "log" | "toml" | "ini" | "cfg" | "conf" | "csv" | "tsv" | "xml" | "html"
        | "css" | "js" | "jsx" | "ts" | "tsx" | "py" | "rs" | "sh" | "ps1" => "text",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" => "image",
        _ => "unsupported",
    }
}

fn markdown_title(path: &Path) -> Option<String> {
    if preview_kind(path) != "markdown" {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_TITLE_BYTES).read_to_end(&mut bytes).ok()?;
    let content = String::from_utf8_lossy(&bytes);
    let mut fence: Option<char> = None;

    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next()?;
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let leading_spaces = line.len().saturating_sub(trimmed.len());
        if leading_spaces > 3 {
            continue;
        }
        let heading_markers = trimmed.chars().take_while(|value| *value == '#').count();
        if !(1..=6).contains(&heading_markers) {
            continue;
        }
        let remainder = &trimmed[heading_markers..];
        if !remainder.starts_with(char::is_whitespace) {
            continue;
        }
        let title = remainder.trim().trim_end_matches('#').trim().to_string();
        if !title.is_empty() {
            return Some(title);
        }
    }
    None
}

fn source_id_matches(source: &ArtifactSource, source_id_value: &str) -> bool {
    if source.id == source_id_value {
        return true;
    }
    if source.is_custom {
        return false;
    }
    if source_id_value == format!("provider-{}", source.provider_id) {
        return true;
    }
    source_id_value
        .strip_prefix(&format!("{}-", source.provider_id))
        .is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix.len() <= 16
                && suffix
                    .chars()
                    .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
        })
}

fn resolve_source(state: &AppState, source_id_value: &str) -> Result<ArtifactSource, String> {
    approved_sources(state, false)?
        .into_iter()
        .find(|source| source_id_matches(source, source_id_value))
        .ok_or_else(|| "The requested artifact source is not approved.".to_string())
}

fn resolve_artifact(
    state: &AppState,
    source_id_value: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let source = resolve_source(state, source_id_value)?;
    let (root, relative) = if source.roots.len() > 1 {
        let requested = Path::new(relative_path);
        let mut components = requested.components();
        let key = components
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            .ok_or_else(|| "The artifact path is outside the approved source.".to_string())?;
        let root = source
            .roots
            .iter()
            .find(|candidate| candidate.key == key)
            .ok_or_else(|| "The artifact path is outside the approved source.".to_string())?;
        let remainder = components.as_path().to_string_lossy().into_owned();
        (root.path.clone(), validate_relative_path(&remainder)?)
    } else {
        (
            source
                .roots
                .first()
                .ok_or_else(|| "The artifact source is unavailable.".to_string())?
                .path
                .clone(),
            validate_relative_path(relative_path)?,
        )
    };
    let root = root
        .canonicalize()
        .map_err(|error| format!("The artifact source is unavailable: {error}"))?;
    if relative.as_os_str().is_empty() {
        return Err("The artifact path is outside the approved source.".to_string());
    }
    let candidate = root.join(&relative);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("The artifact is unavailable: {error}"))?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("The artifact path is outside the approved source.".to_string());
    }
    Ok(canonical)
}

fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err("The artifact path is outside the approved source.".to_string());
    }
    Ok(relative.to_path_buf())
}

#[tauri::command]
fn get_sources(state: State<'_, AppState>) -> Result<Vec<ArtifactSource>, String> {
    approved_sources(&state, true)
}

#[tauri::command]
fn get_prompt_timeline(state: State<'_, AppState>) -> Result<PromptTimeline, String> {
    collect_prompt_timeline(&state)
}

#[tauri::command]
fn list_artifacts(
    state: State<'_, AppState>,
    source_id: String,
) -> Result<Vec<ArtifactEntry>, String> {
    let source = resolve_source(&state, &source_id)?;
    let multiple_roots = source.roots.len() > 1;
    let mut entries = source
        .roots
        .iter()
        .filter(|source_root| source_root.path.is_dir())
        .flat_map(|source_root| {
            artifact_files(&source_root.path, source_root.scan_policy).filter_map(move |entry| {
                let metadata = entry.metadata().ok()?;
                let relative = entry.path().strip_prefix(&source_root.path).ok()?;
                let relative_path = if multiple_roots {
                    Path::new(&source_root.key).join(relative)
                } else {
                    relative.to_path_buf()
                };
                let modified_at = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
                    .unwrap_or_default();
                let created_at = metadata
                    .created()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs());
                let name = entry.file_name().to_string_lossy().into_owned();
                let content_title = markdown_title(entry.path()).unwrap_or_else(|| name.clone());
                Some(ArtifactEntry {
                    relative_path: relative_path.to_string_lossy().into_owned(),
                    absolute_path: entry.path().to_string_lossy().into_owned(),
                    name,
                    extension: entry
                        .path()
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .map(str::to_ascii_lowercase),
                    json_format: match entry
                        .path()
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .unwrap_or_default()
                        .to_ascii_lowercase()
                        .as_str()
                    {
                        "jsonl" => Some("jsonl".to_string()),
                        "json" => Some("json".to_string()),
                        _ => None,
                    },
                    category: classify_entry(entry.path(), relative),
                    artifact_kind: artifact_kind(entry.path()).to_string(),
                    size: metadata.len(),
                    created_at,
                    modified_at,
                    content_title,
                    preview_kind: preview_kind(entry.path()).to_string(),
                })
            })
        })
        .take(MAX_ARTIFACTS)
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));
    Ok(entries)
}

#[tauri::command]
fn read_preview(
    state: State<'_, AppState>,
    source_id: String,
    relative_path: String,
) -> Result<ArtifactPreview, String> {
    let path = resolve_artifact(&state, &source_id, &relative_path)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Could not read artifact metadata: {error}"))?;
    let kind = preview_kind(&path).to_string();

    if kind == "unsupported" {
        return Ok(ArtifactPreview {
            kind,
            content: None,
            data_url: None,
            truncated: false,
            warning: Some(
                "This format is available to export, but cannot be previewed.".to_string(),
            ),
            editable: false,
            revision: None,
        });
    }
    if kind == "image" {
        if metadata.len() > MAX_IMAGE_BYTES {
            return Ok(ArtifactPreview {
                kind,
                content: None,
                data_url: None,
                truncated: false,
                warning: Some("This image is too large to preview safely.".to_string()),
                editable: false,
                revision: None,
            });
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("Could not read the image: {error}"))?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let mime = match extension.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            _ => "image/png",
        };
        return Ok(ArtifactPreview {
            kind,
            content: None,
            data_url: Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))),
            truncated: false,
            warning: None,
            editable: false,
            revision: None,
        });
    }

    let bytes = fs::read(&path).map_err(|error| format!("Could not read the artifact: {error}"))?;
    let truncated = bytes.len() as u64 > MAX_PREVIEW_BYTES;
    let visible = &bytes[..bytes.len().min(MAX_PREVIEW_BYTES as usize)];
    if visible.iter().take(8_192).any(|byte| *byte == 0) {
        return Ok(ArtifactPreview {
            kind: "unsupported".to_string(),
            content: None,
            data_url: None,
            truncated,
            warning: Some("This appears to be a binary file.".to_string()),
            editable: false,
            revision: None,
        });
    }
    let valid_utf8 = String::from_utf8(visible.to_vec());
    let editable = !truncated && valid_utf8.is_ok() && is_editable_kind(&path);
    let content =
        valid_utf8.unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    Ok(ArtifactPreview {
        kind,
        content: Some(content),
        data_url: None,
        truncated,
        warning: truncated.then(|| "Only the first 1 MB is shown.".to_string()),
        editable,
        revision: editable.then(|| content_revision(&bytes)),
    })
}

#[tauri::command]
fn save_artifact(
    state: State<'_, AppState>,
    source_id: String,
    relative_path: String,
    expected_revision: String,
    content: String,
) -> Result<String, String> {
    let path = resolve_artifact(&state, &source_id, &relative_path)?;
    if !is_editable_kind(&path) {
        return Err("Only supported text artifacts can be edited.".to_string());
    }
    replace_text_file(&path, &expected_revision, &content)
}

#[tauri::command]
fn add_custom_folder(state: State<'_, AppState>) -> Result<Option<ArtifactSource>, String> {
    let Some(root) = rfd::FileDialog::new()
        .set_title("Choose an AI artifact folder")
        .pick_folder()
    else {
        return Ok(None);
    };
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("Could not open the selected folder: {error}"))?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Custom artifacts")
        .to_string();
    let id = source_id("custom", &canonical);
    let folder = CustomFolder {
        id: id.clone(),
        name: name.clone(),
        root: canonical.clone(),
    };
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are temporarily unavailable.")?;
    if let Some(existing) = settings.custom_folders.iter().find(|item| item.id == id) {
        return Ok(Some(ArtifactSource {
            id: existing.id.clone(),
            provider_id: "custom".to_string(),
            provider_name: "Custom folder".to_string(),
            name: existing.name.clone(),
            root: existing.root.to_string_lossy().into_owned(),
            available: true,
            is_custom: true,
            artifact_count: count_artifacts(&existing.root, ScanPolicy::All),
            roots: vec![SourceRoot {
                key: "files".to_string(),
                path: existing.root.clone(),
                scan_policy: ScanPolicy::All,
            }],
        }));
    }
    settings.custom_folders.push(folder);
    save_settings(&state, &settings)?;
    Ok(Some(ArtifactSource {
        id,
        provider_id: "custom".to_string(),
        provider_name: "Custom folder".to_string(),
        name,
        root: canonical.to_string_lossy().into_owned(),
        available: true,
        is_custom: true,
        artifact_count: count_artifacts(&canonical, ScanPolicy::All),
        roots: vec![SourceRoot {
            key: "files".to_string(),
            path: canonical,
            scan_policy: ScanPolicy::All,
        }],
    }))
}

#[tauri::command]
fn remove_custom_folder(state: State<'_, AppState>, source_id: String) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "Settings are temporarily unavailable.")?;
    let previous_len = settings.custom_folders.len();
    settings
        .custom_folders
        .retain(|folder| folder.id != source_id);
    if settings.custom_folders.len() == previous_len {
        return Err("The custom folder was not found.".to_string());
    }
    save_settings(&state, &settings)
}

#[tauri::command]
fn trash_artifact(
    state: State<'_, AppState>,
    source_id: String,
    relative_path: String,
    confirmed: bool,
) -> Result<(), String> {
    if !confirmed {
        return Err("Deletion requires explicit confirmation.".to_string());
    }
    let path = resolve_artifact(&state, &source_id, &relative_path)?;
    trash::delete(&path).map_err(|error| format!("Could not move the artifact to trash: {error}"))
}

#[tauri::command]
fn export_artifact(
    state: State<'_, AppState>,
    source_id: String,
    relative_path: String,
) -> Result<Option<String>, String> {
    let source = resolve_artifact(&state, &source_id, &relative_path)?;
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("artifact");
    let Some(destination) = rfd::FileDialog::new()
        .set_title("Export artifact")
        .set_file_name(file_name)
        .save_file()
    else {
        return Ok(None);
    };
    fs::copy(&source, &destination)
        .map_err(|error| format!("Could not export the artifact: {error}"))?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let path = settings_path(&app.handle())?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(&window_title(&app.package_info().version.to_string()))?;
            }
            app.manage(AppState {
                settings: Mutex::new(load_settings(&path)),
                settings_path: path,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sources,
            get_prompt_timeline,
            list_artifacts,
            read_preview,
            save_artifact,
            add_custom_folder,
            remove_custom_folder,
            trash_artifact,
            export_artifact
        ])
        .run(tauri::generate_context!())
        .expect("error while running BrAIn Browser");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_artifact_categories() {
        assert_eq!(classify(Path::new("session-state/abc/plan.md")), "Plans");
        assert_eq!(
            classify(Path::new("projects/session.jsonl")),
            "Session Logs"
        );
        assert_eq!(
            classify(Path::new("session-state/abc/patch.diff")),
            "Other Session Artifacts"
        );
        assert_eq!(classify(Path::new("memory/checkpoint.json")), "Memories");
        assert_eq!(classify(Path::new("logs/client.log")), "Logs");
        assert_eq!(classify(Path::new("settings.json")), "Configuration");
        assert_eq!(classify(Path::new("capture.png")), "Images");
        assert_eq!(classify(Path::new("Cache/index/entry.bin")), "Caches");
        assert_eq!(classify(Path::new("state.sqlite")), "Databases");
        assert_eq!(classify(Path::new("oauth_creds.json")), "Credentials");
        assert_eq!(classify(Path::new("agents/reviewer.agent.md")), "Agents");
        assert_eq!(classify(Path::new("skills/pdf/SKILL.md")), "Skills");
        assert_eq!(
            classify(Path::new("extensions/github.copilot/package.json")),
            "Extensions & Plugins"
        );
        assert_eq!(
            classify(Path::new("hooks/pre-tool-use.sh")),
            "Commands & Hooks"
        );
        assert_eq!(
            classify(Path::new("instructions/security.instructions.md")),
            "Rules & Instructions"
        );
    }

    #[test]
    fn window_title_includes_the_application_version() {
        assert_eq!(window_title("0.9.3"), "BrAIn Browser v0.9.3");
    }

    #[test]
    fn identifies_supported_preview_types() {
        assert_eq!(preview_kind(Path::new("plan.md")), "markdown");
        assert_eq!(preview_kind(Path::new("session.jsonl")), "json");
        assert_eq!(preview_kind(Path::new("config.yaml")), "yaml");
        assert_eq!(preview_kind(Path::new("screen.webp")), "image");
        assert_eq!(preview_kind(Path::new("cache.db")), "unsupported");
    }

    #[test]
    fn rejects_paths_outside_an_approved_root() {
        assert!(validate_relative_path("../secret.txt").is_err());
        assert!(validate_relative_path("/Users/someone/secret.txt").is_err());
        #[cfg(target_os = "windows")]
        assert!(validate_relative_path(r"C:\Users\someone\secret.txt").is_err());
        assert!(validate_relative_path("sessions/valid.jsonl").is_ok());
    }

    #[test]
    fn built_in_source_ids_survive_display_root_changes() {
        let first = built_in_source_id("copilot-vscode", Path::new("first-root"));
        let second = built_in_source_id("copilot-vscode", Path::new("second-root"));

        assert_eq!(first, second);
    }

    #[test]
    fn built_in_sources_accept_current_and_legacy_source_ids() {
        let source = ArtifactSource {
            id: built_in_source_id("copilot-vscode", Path::new("current-root")),
            provider_id: "copilot-vscode".to_string(),
            provider_name: "GitHub Copilot in VS Code".to_string(),
            name: "GitHub Copilot in VS Code".to_string(),
            root: "current-root".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let legacy_id = source_id("copilot-vscode", Path::new("legacy-root"));

        assert!(source_id_matches(&source, "copilot-vscode"));
        assert!(source_id_matches(&source, "provider-copilot-vscode"));
        assert!(source_id_matches(&source, &legacy_id));
        assert!(!source_id_matches(
            &source,
            "copilot-vscode-not-a-legacy-hash"
        ));

        let custom_source = ArtifactSource {
            id: "custom-current".to_string(),
            provider_id: "custom".to_string(),
            provider_name: "Custom folder".to_string(),
            name: "Custom folder".to_string(),
            root: "custom-root".to_string(),
            available: true,
            is_custom: true,
            artifact_count: 0,
            roots: Vec::new(),
        };
        assert!(!source_id_matches(&custom_source, "custom-deadbeef"));
    }

    #[test]
    fn extracts_first_markdown_heading_outside_code_fences() {
        let directory =
            std::env::temp_dir().join(format!("brain-browser-title-test-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("plan.md");
        fs::write(
            &path,
            "```md\n# Not the title\n```\n\n## Authentication rollout ##\n",
        )
        .expect("write test file");

        assert_eq!(
            markdown_title(&path).as_deref(),
            Some("Authentication rollout")
        );
        fs::remove_file(path).expect("remove test file");
        fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn returns_no_content_title_for_non_markdown_files() {
        assert_eq!(markdown_title(Path::new("session.jsonl")), None);
    }

    #[test]
    fn catalog_includes_major_ai_desktop_and_cli_apps() {
        let ids = PROVIDERS
            .iter()
            .map(|provider| provider.id)
            .collect::<Vec<_>>();
        for expected in [
            "copilot",
            "copilot-vscode",
            "microsoft-copilot",
            "microsoft-365-copilot",
            "claude-code",
            "claude-desktop",
            "openai",
            "perplexity",
            "gemini",
            "continue",
            "cursor",
            "windsurf",
            "cline",
        ] {
            assert!(ids.contains(&expected), "missing provider {expected}");
        }
        assert!(!ids.contains(&"codex"));
        assert!(!ids.contains(&"chatgpt-desktop"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn discovers_current_claude_desktop_windows_roots() {
        let directory = tempfile::tempdir().expect("create test directory");
        let home = directory.path().join("home");
        let roaming = directory.path().join("roaming");
        let local = directory.path().join("local");
        let package = local.join("Packages").join("Claude_test");
        let package_data = package.join("LocalCache").join("Roaming").join("Claude");
        for path in [
            roaming.join("Claude"),
            local.join("Claude"),
            local.join("Claude-3p"),
            package_data.clone(),
        ] {
            fs::create_dir_all(path).expect("create Claude root");
        }

        let roots =
            claude_desktop_windows_roots(&home, Some(&roaming), Some(&local), vec![package]);
        let paths = roots
            .iter()
            .map(|root| (root.key.as_str(), root.path.as_path(), root.scan_policy))
            .collect::<Vec<_>>();

        assert!(paths.contains(&(
            "desktop-roaming",
            roaming.join("Claude").as_path(),
            ScanPolicy::ClaudeDesktop,
        )));
        assert!(paths.contains(&(
            "desktop-local",
            local.join("Claude").as_path(),
            ScanPolicy::ClaudeDesktop,
        )));
        assert!(paths.contains(&(
            "managed",
            local.join("Claude-3p").as_path(),
            ScanPolicy::ClaudeDesktop,
        )));
        assert!(paths.contains(&(
            "managed-legacy",
            roaming.join("Claude-3p").as_path(),
            ScanPolicy::ClaudeDesktop,
        )));
        assert!(paths.contains(&("outputs", home.join("Claude").as_path(), ScanPolicy::All,)));
        assert!(paths.contains(&(
            "outputs-legacy",
            home.join("Documents").join("Claude").as_path(),
            ScanPolicy::All,
        )));
        assert!(paths.contains(&(
            "package-1",
            package_data.as_path(),
            ScanPolicy::ClaudeDesktop,
        )));
        assert!(!paths
            .iter()
            .any(|(_, path, _)| *path == local.join("Packages")));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reports_claude_desktop_unavailable_without_existing_roots() {
        let directory = tempfile::tempdir().expect("create test directory");
        let home = directory.path().join("home");
        let roaming = directory.path().join("roaming");
        let local = directory.path().join("local");
        let roots = claude_desktop_windows_roots(&home, Some(&roaming), Some(&local), Vec::new());

        assert!(!roots.iter().any(|root| root.path.is_dir()));
    }

    #[test]
    fn excludes_claude_browser_profile_noise_only_for_claude_roots() {
        let directory = tempfile::tempdir().expect("create test directory");
        let root = directory.path();
        for path in [
            root.join("logs").join("main.log"),
            root.join("claude-code-sessions").join("session.jsonl"),
            root.join("local-agent-mode-sessions").join("state.json"),
            root.join("Cache").join("Cache_Data").join("data_0"),
            root.join("Network").join("Cookies"),
            root.join("IndexedDB").join("000003.log"),
        ] {
            fs::create_dir_all(path.parent().expect("artifact parent"))
                .expect("create artifact parent");
            fs::write(path, "{}").expect("write artifact");
        }
        fs::write(root.join("claude_desktop_config.json"), "{}").expect("write config");

        let claude_files = artifact_files(root, ScanPolicy::ClaudeDesktop)
            .filter_map(|entry| entry.path().strip_prefix(root).ok().map(Path::to_path_buf))
            .collect::<Vec<_>>();
        assert!(claude_files.contains(&PathBuf::from("claude_desktop_config.json")));
        assert!(claude_files.contains(&PathBuf::from("logs").join("main.log")));
        assert!(claude_files.contains(&PathBuf::from("claude-code-sessions").join("session.jsonl")));
        assert!(
            claude_files.contains(&PathBuf::from("local-agent-mode-sessions").join("state.json"))
        );
        assert!(!claude_files.iter().any(|path| path.starts_with("Cache")));
        assert!(!claude_files.iter().any(|path| path.starts_with("Network")));
        assert!(!claude_files
            .iter()
            .any(|path| path.starts_with("IndexedDB")));

        let custom_files = artifact_files(root, ScanPolicy::All)
            .filter_map(|entry| entry.path().strip_prefix(root).ok().map(Path::to_path_buf))
            .collect::<Vec<_>>();
        assert!(custom_files.iter().any(|path| path.starts_with("Cache")));
        assert!(custom_files.iter().any(|path| path.starts_with("Network")));
    }

    #[test]
    fn identifies_database_archive_and_binary_artifacts() {
        assert_eq!(artifact_kind(Path::new("state.sqlite")), "database");
        assert_eq!(artifact_kind(Path::new("IndexedDB/000003.log")), "database");
        assert_eq!(artifact_kind(Path::new("bundle.asar")), "archive");
        assert_eq!(artifact_kind(Path::new("cache.bin")), "binary");
        assert_eq!(artifact_kind(Path::new("settings.json")), "document");
    }

    #[test]
    fn detects_mcp_configuration_files() {
        let directory =
            std::env::temp_dir().join(format!("brain-browser-mcp-test-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("create test directory");
        let named = directory.join("mcp_config.json");
        let content = directory.join("settings.json");
        fs::write(&named, "{}").expect("write named config");
        fs::write(&content, r#"{"mcpServers":{"local":{"command":"tool"}}}"#)
            .expect("write content config");

        assert!(is_mcp_configuration(&named));
        assert!(is_mcp_configuration(&content));
        fs::remove_file(named).expect("remove named config");
        fs::remove_file(content).expect("remove content config");
        fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn safely_replaces_text_and_rejects_stale_revisions() {
        let directory =
            std::env::temp_dir().join(format!("brain-browser-save-test-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("settings.json");
        let original = br#"{"enabled":false}"#;
        fs::write(&path, original).expect("write original");
        let revision = content_revision(original);

        let next_revision =
            replace_text_file(&path, &revision, "{\n  \"enabled\": true\n}\n").expect("save text");
        assert_ne!(revision, next_revision);
        assert_eq!(
            fs::read_to_string(&path).expect("read saved text"),
            "{\n  \"enabled\": true\n}\n"
        );
        assert!(replace_text_file(&path, &revision, "stale").is_err());
        fs::remove_file(path).expect("remove test file");
        fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn extracts_timeline_prompts_from_common_provider_shapes() {
        let source = ArtifactSource {
            id: "source".to_string(),
            provider_id: "openai".to_string(),
            provider_name: "OpenAI".to_string(),
            name: "OpenAI".to_string(),
            root: "test".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let codex: Value =
            serde_json::from_str(r#"{"session_id":"abc","ts":200,"text":"Build it"}"#)
                .expect("parse codex");
        let claude: Value = serde_json::from_str(
            r#"{"type":"user","timestamp":"2026-09-12T10:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Review it"}]}}"#,
        )
        .expect("parse claude");

        let codex_prompt =
            timeline_prompt_from_value(&codex, &source, Path::new("history.jsonl"), None)
                .expect("extract codex");
        let claude_prompt =
            timeline_prompt_from_value(&claude, &source, Path::new("session.jsonl"), None)
                .expect("extract claude");
        assert_eq!(codex_prompt.text, "Build it");
        assert_eq!(codex_prompt.timestamp_ms, Some(200_000));
        assert_eq!(codex_prompt.provider_id, "openai");
        assert_eq!(codex_prompt.provider_name, "OpenAI");
        assert_eq!(claude_prompt.text, "Review it");
        assert!(claude_prompt.timestamp_ms.is_some());
    }

    #[test]
    fn derives_session_id_from_generic_transcript_parent() {
        assert_eq!(
            fallback_session_id(Path::new("session-state/abc-123/events.jsonl")),
            "abc-123"
        );
        assert_eq!(
            fallback_session_id(Path::new("projects/my-session.jsonl")),
            "my-session"
        );
    }

    #[test]
    fn ignores_assistant_timeline_records() {
        let source = ArtifactSource {
            id: "source".to_string(),
            provider_id: "claude-code".to_string(),
            provider_name: "Claude Code".to_string(),
            name: "Claude Code".to_string(),
            root: "test".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let assistant: Value = serde_json::from_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":"Done"}}"#,
        )
        .expect("parse assistant");
        assert!(
            timeline_prompt_from_value(&assistant, &source, Path::new("session.jsonl"), None)
                .is_none()
        );
    }

    #[test]
    fn ignores_tool_output_with_user_content_in_timeline() {
        let source = ArtifactSource {
            id: "source".to_string(),
            provider_id: "copilot".to_string(),
            provider_name: "GitHub Copilot CLI".to_string(),
            name: "GitHub Copilot CLI".to_string(),
            root: "test".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let tool: Value = serde_json::from_str(
            r#"{"type":"tool.execution_complete","user_content":"12583 INFO: Copying 0 resources to EXE\n13220 INFO: Build complete!"}"#,
        )
        .expect("parse tool event");
        assert!(
            timeline_prompt_from_value(&tool, &source, Path::new("events.jsonl"), None).is_none()
        );
    }

    #[test]
    fn ignores_assistant_event_with_user_message_context() {
        let source = ArtifactSource {
            id: "source".to_string(),
            provider_id: "copilot".to_string(),
            provider_name: "GitHub Copilot CLI".to_string(),
            name: "GitHub Copilot CLI".to_string(),
            root: "test".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let assistant: Value = serde_json::from_str(
            r#"{"type":"assistant.message","user_message":"prior context","assistant_content":"response"}"#,
        )
        .expect("parse assistant event");
        assert!(
            timeline_prompt_from_value(&assistant, &source, Path::new("events.jsonl"), None)
                .is_none()
        );
    }

    #[test]
    fn ignores_claude_tool_results_with_user_protocol_role() {
        let source = ArtifactSource {
            id: "source".to_string(),
            provider_id: "claude-code".to_string(),
            provider_name: "Claude Code".to_string(),
            name: "Claude Code".to_string(),
            root: "test".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let tool_result: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"21: from webview.menu import Menu, MenuAction, MenuSeparator\n273:             if window.menu or _state['menu']:"}]}}"#,
        )
        .expect("parse Claude tool result");
        assert!(timeline_prompt_from_value(
            &tool_result,
            &source,
            Path::new("session.jsonl"),
            None
        )
        .is_none());
    }

    #[test]
    fn keeps_claude_text_blocks_and_omits_tool_results() {
        let source = ArtifactSource {
            id: "source".to_string(),
            provider_id: "claude-code".to_string(),
            provider_name: "Claude Code".to_string(),
            name: "Claude Code".to_string(),
            root: "test".to_string(),
            available: true,
            is_custom: false,
            artifact_count: 0,
            roots: Vec::new(),
        };
        let mixed: Value = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"internal command output"},{"type":"text","text":"Now explain the menu implementation"}]}}"#,
        )
        .expect("parse mixed Claude content");
        let prompt = timeline_prompt_from_value(&mixed, &source, Path::new("session.jsonl"), None)
            .expect("extract Claude text");
        assert_eq!(prompt.text, "Now explain the menu implementation");
    }
}
