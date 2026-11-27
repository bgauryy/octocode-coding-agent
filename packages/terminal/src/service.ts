import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carapaceComplete } from "./carapace.ts";
import { untilSettledOrAborted } from "./abort.ts";
import { DEFAULT_TIMINGS, DriverProcess, type DriverTimings } from "./driver-process.ts";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { PathCommands } from "./executables.ts";
import { BRANCH_SUBCOMMANDS, gitBranches } from "./git-refs.ts";
import { parseShellLine, quoteForShell, type ShellLine } from "./line.ts";
import { type ResolvedShell, resolveShell } from "./shells/index.ts";
import type { DriverMatch, ShellCompletion, ShellCompletionOptions, ShellCompletions } from "./types.ts";

export interface ShellCompletionServiceOptions extends ShellCompletionOptions {
	cwd: string;
	/** The environment shell commands get (provider keys already removed). */
	env: NodeJS.ProcessEnv;
	/** Whether the folder is trusted: only then do shells and carapace run, since completion functions run programs. */
	trusted(): boolean;
	timings?: DriverTimings;
}

/** Restarts after a crash or stall before the shell is given up for the session. */
const MAX_STARTS = 3;

/**
 * Set for the completion shell: `OCTOCODE_SHELL_COMPLETION` lets a startup file skip work it does not need there, and the
 * others turn off update prompts and auto-start plugins that would wait for input or replace the shell.
 */
const COMPLETION_ENV = {
	OCTOCODE_SHELL_COMPLETION: "1",
	DISABLE_AUTO_UPDATE: "true",
	DISABLE_UPDATE_PROMPT: "true",
	ZSH_TMUX_AUTOSTART: "false",
	POWERLEVEL9K_INSTANT_PROMPT: "off",
};

/**
 * Completions for a `!` command line. In a trusted folder the user's shell answers first (a long-lived driver started at
 * the first request); then PATH programs for the command name, local git branches, and carapace when it is installed.
 * In a folder that is not trusted only PATH programs and git branches (read from files) answer. Undefined means no source
 * had anything: the caller falls back to file paths.
 */
export class ShellCompletionService {
	private driver: DriverProcess | undefined;
	private dir: string | undefined;
	private starts = 0;
	private starting: Promise<DriverProcess | undefined> | undefined;
	/** Counts stops: a driver whose start began before a stop is not started. */
	private generation = 0;
	private shell: ResolvedShell | undefined | null = null;
	private carapace: string | undefined | null = null;
	private readonly path = new PathCommands();
	private options: ShellCompletionServiceOptions;

	constructor(options: ShellCompletionServiceOptions) {
		this.options = options;
	}

	/** The shell the service drives, once resolved (`auto` follows `$SHELL`). */
	get shellName(): string | undefined {
		return this.resolved()?.spec.name;
	}

	/** Follows a new working folder or settings: the running shell stops and the next request starts one there. */
	update(options: Partial<ShellCompletionServiceOptions>): void {
		const next = { ...this.options, ...options };
		const restart =
			next.cwd !== this.options.cwd || next.shell !== this.options.shell || next.loadRc !== this.options.loadRc;
		this.options = next;
		if (restart) {
			this.stopDriver();
			this.shell = null;
			this.starts = 0;
		}
	}

	private resolved(): ResolvedShell | undefined {
		if (this.shell === null) this.shell = resolveShell(this.options.shell, this.options.env);
		return this.shell;
	}

	/** The running driver, or one being started (its startup files written without blocking the first Tab). */
	private startDriver(): Promise<DriverProcess | undefined> {
		if (this.driver && !this.driver.isClosed) return Promise.resolve(this.driver);
		this.starting ??= this.launchDriver().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async launchDriver(): Promise<DriverProcess | undefined> {
		const shell = this.resolved();
		if (!shell || this.starts >= MAX_STARTS) return undefined;
		this.starts++;
		const generation = this.generation;
		this.removeDir();
		const dir = await mkdtemp(join(tmpdir(), `octocode-${shell.spec.name}-`));
		try {
			await Promise.all(
				Object.entries(shell.spec.files).map(([name, content]) => writeFile(join(dir, name), content, { mode: 0o600 })),
			);
		} catch (error) {
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
		// Stopped (a new folder, settings, dispose) while the files were written: start nothing.
		if (generation !== this.generation) {
			rmSync(dir, { recursive: true, force: true });
			return undefined;
		}
		this.dir = dir;
		const env = { ...this.options.env, ...COMPLETION_ENV };
		const launch = shell.spec.launch({ binary: shell.binary, dir, loadRc: this.options.loadRc, env });
		const driver = new DriverProcess(
			{ ...launch, cwd: this.options.cwd },
			this.options.timings ?? DEFAULT_TIMINGS,
			() => {
				if (this.driver === driver) this.driver = undefined;
			},
		);
		this.driver = driver;
		return driver;
	}

	/** Completions for `text`, the command line before the cursor without its `!`. */
	async complete(text: string, signal: AbortSignal): Promise<ShellCompletions | undefined> {
		const line = parseShellLine(text);
		const trusted = this.options.trusted();
		if (trusted) {
			const fromShell = await this.fromShell(text, line, signal);
			if (fromShell?.items.length) return fromShell;
		}
		if (signal.aborted) return undefined;
		if (line.commandPosition && !line.openQuote) {
			const names = await untilSettledOrAborted(this.path.list(this.options.env), signal);
			if (!names || signal.aborted) return undefined;
			const items = names
				.filter((name) => name.startsWith(line.currentValue))
				.map((name): ShellCompletion => ({ value: quoteForShell(name), label: name, kind: "command" }));
			return items.length ? { start: line.currentStart, items, source: "path" } : undefined;
		}
		const branches = await untilSettledOrAborted(this.branchCompletions(line, signal), signal);
		if (signal.aborted) return undefined;
		if (branches) return branches;
		if (trusted && this.options.carapace) return this.fromCarapace(line, signal);
		return undefined;
	}

	private async fromShell(text: string, line: ShellLine, signal: AbortSignal): Promise<ShellCompletions | undefined> {
		const driver = await this.startDriver();
		if (signal.aborted) return undefined;
		const spec = this.shell?.spec;
		if (!driver || !spec) return undefined;
		const offset = spec.segmentOnly ? line.segmentStart : 0;
		const matches = await driver.request(text.slice(offset), signal);
		if (!matches?.length) return undefined;
		return toCompletions(matches, line, offset, spec.name);
	}

	private async branchCompletions(line: ShellLine, signal: AbortSignal): Promise<ShellCompletions | undefined> {
		if (line.words[0] !== "git" || line.words.length < 2 || !BRANCH_SUBCOMMANDS.has(line.words[1])) return undefined;
		if (line.currentValue.startsWith("-")) return undefined;
		const items = (await gitBranches(this.options.cwd, signal))
			.filter((name) => name.startsWith(line.currentValue))
			.map((name): ShellCompletion => ({
				value: quoteForShell(name, line.openQuote),
				label: name,
				description: "branch",
			}));
		return items.length ? { start: line.currentStart, items, source: "git" } : undefined;
	}

	private async fromCarapace(line: ShellLine, signal: AbortSignal): Promise<ShellCompletions | undefined> {
		if (this.carapace === null) this.carapace = findOnPath("carapace", this.options.env);
		if (!this.carapace) return undefined;
		const matches = await carapaceComplete(this.carapace, [...line.words, line.currentValue], {
			cwd: this.options.cwd,
			env: this.options.env,
			signal,
		});
		if (!matches?.length) return undefined;
		return toCompletions(matches, line, 0, "carapace");
	}

	private stopDriver(): void {
		this.generation++;
		this.driver?.close();
		this.driver = undefined;
		this.removeDir();
	}

	private removeDir(): void {
		if (!this.dir) return;
		try {
			rmSync(this.dir, { recursive: true, force: true });
		} catch {
			// A leftover temporary directory is harmless.
		}
		this.dir = undefined;
	}

	dispose(): void {
		this.stopDriver();
	}
}

/** Shell matches as completions of the word being typed; `offset` is where the driver's text started in the line. */
export function toCompletions(
	matches: readonly DriverMatch[],
	line: ShellLine,
	offset: number,
	source: string,
): ShellCompletions {
	const seen = new Set<string>();
	const items: ShellCompletion[] = [];
	let start = line.currentStart;
	for (const match of matches) {
		const at = /@(\d+)/.exec(match.flags)?.[1];
		if (at !== undefined) start = offset + Number(at);
		const quoted = match.flags.includes("q");
		// bash completion functions end a word with a space to ask for one after it; that space is not part of the word.
		const raw = quoted ? match.value : match.value.trimEnd();
		if (!raw) continue;
		const directory = match.flags.includes("d") || raw.endsWith("/");
		// A shell quotes what goes inside an open quote, so the quote the word started with is kept in front of it.
		const value = quoted
			? `${line.openQuote && at === undefined && !raw.startsWith(line.openQuote) ? line.openQuote : ""}${raw}`
			: quoteForShell(raw, line.openQuote, directory);
		if (seen.has(value)) continue;
		seen.add(value);
		const label = raw;
		items.push({
			// Inside an open quote the quote stays open for a directory, so the slash goes inside it.
			value: directory && !value.endsWith("/") ? `${value}/` : value,
			label: directory && !label.endsWith("/") ? `${label}/` : label,
			...(match.description ? { description: match.description } : {}),
			...(directory ? { kind: "directory" as const } : {}),
			...(directory || match.flags.includes("n") || /[=:/]$/.test(raw) ? { noSpace: true } : {}),
		});
	}
	return { start, items, source };
}
