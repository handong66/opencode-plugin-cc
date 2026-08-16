export const SESSION_ID_ENV = "OPENCODE_COMPANION_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "OPENCODE_COMPANION_TRANSCRIPT_PATH";
// Namespaced snapshot of this plugin's data dir. CLAUDE_PLUGIN_DATA is only
// reliable inside our own hook processes; in the shared session env file any
// plugin that exports it last wins (the Codex plugin does exactly that), so
// commands must read the namespaced variable instead.
export const DATA_DIR_ENV = "OPENCODE_COMPANION_DATA_DIR";
export const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
// Set by a parent that has already run the readiness probe (`opencode
// --version` + `opencode auth list`, ~1.1s) so the child does not repeat it.
// Only ever set by this plugin's own hooks for a process they spawn.
export const READY_ENV = "OPENCODE_COMPANION_READY";
