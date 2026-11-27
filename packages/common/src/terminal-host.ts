/** The program that hosts this process's terminal, decided from environment variables alone. */

type Env = Readonly<Record<string, string | undefined>>;

export type CodeIde = "code" | "code-insiders" | "codium" | "cursor";

/**
 * The IDE whose integrated terminal runs Octocode, by its CLI name. Code and its forks set `TERM_PROGRAM=vscode`;
 * `VSCODE_IPC_HOOK_CLI` (remote terminals) and `VSCODE_GIT_IPC_HANDLE` stay set inside tmux, which replaces
 * `TERM_PROGRAM`. Cursor sets `CURSOR_TRACE_ID`; the Git askpass paths name the application folder.
 */
export function detectIde(env: Env): CodeIde | undefined {
	if (env.TERM_PROGRAM !== "vscode" && !env.VSCODE_IPC_HOOK_CLI && !env.VSCODE_GIT_IPC_HANDLE) return undefined;
	const install = `${env.VSCODE_GIT_ASKPASS_NODE ?? ""}\n${env.VSCODE_GIT_ASKPASS_MAIN ?? ""}`;
	if (env.CURSOR_TRACE_ID || /cursor/i.test(install)) return "cursor";
	if (/insiders/i.test(install) || /-insider$/i.test(env.TERM_PROGRAM_VERSION ?? "")) return "code-insiders";
	if (/codium/i.test(install)) return "codium";
	return "code";
}

const IDE_NAMES: Record<CodeIde, string> = {
	code: "VS Code",
	"code-insiders": "VS Code Insiders",
	codium: "VSCodium",
	cursor: "Cursor",
};

/**
 * The terminal emulator, by the variables each one sets. Under tmux `TERM_PROGRAM` names tmux, but the emulator's own
 * variables (`KITTY_WINDOW_ID`, `WEZTERM_PANE`, ...) stay set, so those are checked first.
 */
function detectTerminal(env: Env): string | undefined {
	const program = env.TERM_PROGRAM?.toLowerCase() ?? "";
	if (env.KITTY_WINDOW_ID || program === "kitty" || env.TERM === "xterm-kitty") return "kitty";
	if (program === "ghostty" || env.GHOSTTY_RESOURCES_DIR || env.TERM?.includes("ghostty")) return "Ghostty";
	if (env.WEZTERM_PANE || program === "wezterm") return "WezTerm";
	if (program === "iterm.app" || env.ITERM_SESSION_ID) return "iTerm2";
	if (program === "apple_terminal") return "Apple Terminal";
	if (program === "warpterminal") return "Warp";
	if (env.ALACRITTY_WINDOW_ID || program === "alacritty") return "Alacritty";
	if (env.WT_SESSION) return "Windows Terminal";
	return undefined;
}

function ideName(env: Env): string | undefined {
	const ide = detectIde(env);
	if (ide) return IDE_NAMES[ide];
	if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return "JetBrains";
	if (env.ZED_TERM || env.TERM_PROGRAM?.toLowerCase() === "zed") return "Zed";
	return undefined;
}

/**
 * What hosts this terminal, outermost first: the emulator, the IDE whose terminal it is, tmux, SSH; empty when none
 * is recognized (a pipe, a service, an unknown emulator).
 */
export function terminalHostFacts(env: Env): string[] {
	const facts: string[] = [];
	const terminal = detectTerminal(env);
	if (terminal) facts.push(terminal);
	const ide = ideName(env);
	if (ide) facts.push(`${ide} terminal`);
	if (env.TMUX) facts.push("tmux");
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) facts.push("SSH");
	return facts;
}
