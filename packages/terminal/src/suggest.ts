/** A command the user ran with `!`, summarized across runs. */
export interface HistoryEntry {
	command: string;
	/** Where it last ran. */
	cwd: string;
	count: number;
	/** When it last ran (epoch milliseconds). */
	lastAt: number;
	/** Its last exit code, when known. */
	lastExit?: number | null;
}

const DAY_MS = 86_400_000;

function score(entry: HistoryEntry, cwd: string, now: number): number {
	const ageDays = Math.max(0, now - entry.lastAt) / DAY_MS;
	let value = Math.log2(1 + entry.count) - ageDays / 7;
	if (entry.cwd === cwd) value += 2;
	if (entry.lastExit !== undefined && entry.lastExit !== null && entry.lastExit !== 0) value -= 3;
	return value;
}

/** The best history command that extends `prefix` (and is longer than it), preferring this folder, recent, frequent and successful runs. */
export function rankHistory(
	entries: readonly HistoryEntry[],
	prefix: string,
	cwd: string,
	now = Date.now(),
): string | undefined {
	let best: { command: string; score: number } | undefined;
	for (const entry of entries) {
		if (!prefix || entry.command.length <= prefix.length || !entry.command.startsWith(prefix)) continue;
		const value = score(entry, cwd, now);
		if (!best || value > best.score) best = { command: entry.command, score: value };
	}
	return best?.command;
}

const SHELL_FENCES = new Set([
	"",
	"sh",
	"bash",
	"zsh",
	"fish",
	"shell",
	"console",
	"terminal",
	"shellsession",
	"pwsh",
	"powershell",
	"ps1",
]);

/**
 * One-line commands in the shell code blocks of a markdown reply, in order: a `$ ` or `> ` prompt is removed, comments,
 * blank lines and continued lines (ending in `\`) are skipped, and output lines of a `console` block (no prompt) too.
 */
export function replyCommands(markdown: string): string[] {
	const commands: string[] = [];
	const fence = /^(\s*)(```+|~~~+)\s*([\w-]*)[^\n]*\n([\s\S]*?)^\1\2\s*$/gm;
	for (const match of markdown.matchAll(fence)) {
		const lang = match[3].toLowerCase();
		if (!SHELL_FENCES.has(lang)) continue;
		const promptOnly = lang === "console" || lang === "shellsession" || lang === "terminal";
		const lines = match[4].split("\n");
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].trim();
			const prompted = /^(\$|>|PS [^>]*>)\s+/.exec(line);
			if (prompted) line = line.slice(prompted[0].length);
			else if (promptOnly) continue;
			if (!line || line.startsWith("#")) continue;
			if (line.endsWith("\\") || (i > 0 && lines[i - 1].trim().endsWith("\\"))) continue;
			if (/[\x00-\x1f\x7f]/.test(line)) continue;
			if (!commands.includes(line)) commands.push(line);
		}
	}
	return commands;
}

/**
 * The deterministic ghost text for `prefix` (what follows `!`): a command from the last reply that extends it, else the
 * best history match. With an empty prefix, the first command of the last reply.
 */
export function suggestCommand(
	prefix: string,
	options: { cwd: string; history: readonly HistoryEntry[]; reply: readonly string[]; now?: number },
): string | undefined {
	if (!prefix) return options.reply[0];
	const fromReply = options.reply.find((command) => command.length > prefix.length && command.startsWith(prefix));
	return fromReply ?? rankHistory(options.history, prefix, options.cwd, options.now);
}
