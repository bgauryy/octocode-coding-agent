import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ExternalUsage } from "@octocodeai/octocode-contracts/external";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { clip } from "../shared/text.ts";
import { adoptTree, KILL_GRACE_MS, prepareTree, stopTree } from "../shared/process.ts";
import { pollDescendants } from "../shared/descendant-poller.ts";
import { agentEnv } from "./runner-env.ts";
import type { RunnerBilling } from "./runners.ts";
import { CLAUDE_ISOLATION_ARGS } from "./runner-isolation.ts";
import { checkRunnerCommunication, type RunnerCommunication, withCommunicationConfig } from "./runner-communication.ts";

/**
 * Alternative D of the subscriptions RFC: when Claude Code is installed and signed in but its ACP adapter
 * (`claude-agent-acp`) is not, a task runs in `claude -p` instead and its JSON event stream is read as the ACP turn
 * would be. Every flag below is in `claude --help` of Claude Code 2.1.325 (checked 2026-11-15).
 */

/** The `/providers` runner row's word for this route. */
export const HEADLESS_ROUTE = "headless (adapter missing)";

/** The runners with a headless route: only Claude Code's CLI was checked for one. */
const HEADLESS_RUNNERS = new Set(["claude-code"]);

/** The parts of a runner's checked state the route depends on (structural, so `runner-status.ts` can import this file). */
interface RouteState {
	id: string;
	cli: boolean;
	adapter: boolean;
	auth?: { signedIn: boolean };
}

/** Whether `state` runs headless: its CLI is installed and signed in, its adapter is missing, and it has the route. */
export const headlessReady = (state: RouteState): boolean => headlessAvailable(state) && state.auth?.signedIn === true;

/** Whether the installed CLI has a supported headless route, before its sign-in is checked. */
export const headlessAvailable = (state: RouteState): boolean =>
	HEADLESS_RUNNERS.has(state.id) && state.cli && !state.adapter;

/** The route a runner's row names when it is not the ACP adapter; undefined for the adapter route or none. */
export const runnerRoute = (state: RouteState): string | undefined =>
	headlessReady(state) ? HEADLESS_ROUTE : undefined;

/**
 * The fixed part of the command: `-p` prints and exits (no prompt argument: the task comes on stdin, so its length and
 * any secret in it never reach argv), and `--output-format stream-json` streams one JSON event per line, which needs
 * `--verbose` with `-p`. Streaming input delivers the task without ending the process's input channel.
 */
export const HEADLESS_ARGS: readonly string[] = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--verbose",
	...CLAUDE_ISOLATION_ARGS,
];

/**
 * Permissions, since headless mode sends no ACP permission request Octocode could answer. `--permission-prompts none`
 * denies whatever would prompt; the mode decides the rest. In its own worktree a task gets `acceptEdits`: Claude Code
 * accepts file edits inside its working directory only, so edits outside it, and every command or fetch its user's
 * own allow rules do not cover, are denied. A task in the session's own folder gets `manual`: nothing is accepted
 * that would ask, so it cannot change the user's checkout. Never `bypassPermissions` or `--dangerously-skip-permissions`.
 */
function headlessPermissionArgs(isolated: boolean): string[] {
	return ["--permission-mode", isolated ? "acceptEdits" : "manual", "--permission-prompts", "none"];
}

/** What a headless turn needs; `awake` restarts the caller's idle timer on every event. */
interface HeadlessTurnInput {
	runner: string;
	command: string;
	args: readonly string[];
	billing?: RunnerBilling;
	model?: string;
	communication?: RunnerCommunication;
	cwd: string;
	/** The session's own folder: a task elsewhere runs in its worktree. */
	sessionCwd: string;
	text: string;
	signal: AbortSignal;
	onActivity(line: string): void;
	onStart?(pid: number): void;
	awake(): void;
}

export interface HeadlessReply {
	text: string;
	stopReason?: string;
	usage?: ExternalUsage;
	cost?: number;
	billing?: RunnerBilling;
}

/** A failure Claude Code reports as its sign-in: the caller drops the cached check, as for ACP `auth_required`. */
export class HeadlessSignedOut extends Error {}

const SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token (has )?expired|authentication_error/i;
/** The most of stderr kept for a failure message: the tail says why it exited. */
const STDERR_TAIL = 8 * 1024;
/** The input fields that name what a Claude Code tool acts on, in the order a row line prefers them. */
const TARGET_FIELDS = ["file_path", "notebook_path", "command", "pattern", "path", "url", "query", "description"];
/** Claude Code's result subtypes as ACP stop reasons (`runner-child.ts` reads those). */
const RESULT_STOPS: Record<string, string> = {
	error_max_turns: "max_turn_requests",
	error_max_budget_usd: "max_tokens",
};
const API_STOPS = new Set(["end_turn", "max_tokens", "refusal"]);

const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A tool call as one short row line, like an ACP `tool_call` title: the tool and what it acts on. */
function toolLine(block: Record<string, unknown>, roots: readonly string[]): string {
	const name = typeof block.name === "string" && block.name ? block.name : "tool";
	const input = isRecord(block.input) ? block.input : {};
	const field = TARGET_FIELDS.find((key) => typeof input[key] === "string" && input[key]);
	let target = field ? String(input[field]) : "";
	const root = path.isAbsolute(target) ? roots.find((each) => target.startsWith(`${each}${path.sep}`)) : undefined;
	if (root) target = path.relative(root, target);
	return `→ ${clip(redactSecrets(target ? `${name} ${target}` : name), 120)}`;
}

/** Claude Code's `usage` (Anthropic field names) as the totals an ACP turn reports. */
function usageOf(value: unknown): ExternalUsage | undefined {
	if (!isRecord(value)) return undefined;
	const inputTokens = num(value.input_tokens);
	const outputTokens = num(value.output_tokens);
	if (inputTokens === undefined || outputTokens === undefined) return undefined;
	const cachedReadTokens = num(value.cache_read_input_tokens);
	const cachedWriteTokens = num(value.cache_creation_input_tokens);
	return {
		inputTokens,
		outputTokens,
		...(cachedReadTokens ? { cachedReadTokens } : {}),
		...(cachedWriteTokens ? { cachedWriteTokens } : {}),
		totalTokens: inputTokens + outputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0),
	};
}

/** The text blocks of an assistant event: the answer when the result event carries none. */
const textOf = (content: unknown[]): string =>
	content
		.filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => (block as { text: string }).text)
		.join("");

/** Reads the event stream: tool calls go to the row, the last assistant text and the result event are kept. */
class StreamReader {
	lastText = "";
	result: Record<string, unknown> | undefined;
	/** The task folder as given and as the CLI sees it (symlinks resolved): its paths show relative to it. */
	private readonly roots: string[];
	private readonly input: HeadlessTurnInput;
	constructor(input: HeadlessTurnInput) {
		this.input = input;
		this.roots = [path.resolve(input.cwd)];
		try {
			this.roots.push(realpathSync(input.cwd));
		} catch {
			// A folder that cannot be resolved shows its paths in full.
		}
	}

	line(raw: string): void {
		this.input.awake();
		let event: unknown;
		try {
			event = JSON.parse(raw);
		} catch {
			return; // A line that is not an event (a warning) is not part of the answer.
		}
		if (!isRecord(event)) return;
		if (event.type === "result") {
			this.result = event;
			const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
			for (const denial of denials)
				if (isRecord(denial) && typeof denial.tool_name === "string")
					this.input.onActivity(`✗ denied ${clip(redactSecrets(denial.tool_name), 60)}`);
			return;
		}
		if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return;
		const content = event.message.content;
		const text = textOf(content);
		if (text) this.lastText = text;
		for (const block of content)
			if (isRecord(block) && block.type === "tool_use") this.input.onActivity(toolLine(block, this.roots));
	}

	/** The turn's reply from the result event; a failed run throws, a signed-out one as `HeadlessSignedOut`. */
	reply(code: number | null, stderr: string): HeadlessReply {
		const result = this.result;
		const billing = this.input.billing;
		if (!result) {
			const why = redactSecrets(stderr.trim()) || `exit code ${code}`;
			if (SIGNED_OUT.test(why)) throw new HeadlessSignedOut(why);
			throw new Error(`${this.input.runner} (headless) ended without a result: ${why}`);
		}
		const text = typeof result.result === "string" && result.result ? result.result : this.lastText;
		const subtype = typeof result.subtype === "string" ? result.subtype : "";
		const stop =
			RESULT_STOPS[subtype] ??
			(typeof result.stop_reason === "string" && API_STOPS.has(result.stop_reason) ? result.stop_reason : "end_turn");
		const failed = result.is_error === true || (subtype !== "success" && !(subtype in RESULT_STOPS));
		if (failed) {
			const errors = Array.isArray(result.errors) ? result.errors.filter((each) => typeof each === "string") : [];
			const why = redactSecrets([text, ...errors, stderr.trim()].filter(Boolean).join("\n")) || subtype || "error";
			if (SIGNED_OUT.test(why)) throw new HeadlessSignedOut(why);
			throw new Error(`${this.input.runner} (headless) failed: ${why}`);
		}
		const usage = usageOf(result.usage);
		const cost = num(result.total_cost_usd);
		return {
			text,
			stopReason: stop,
			...(usage ? { usage } : {}),
			...(cost !== undefined ? { cost } : {}),
			billing,
		};
	}
}

const abortError = (signal: AbortSignal): Error =>
	signal.reason instanceof Error ? signal.reason : new Error("Runner turn cancelled");

/**
 * One task's turn in `claude -p`: started in the task's folder with the cleaned environment (`agentEnv`), as the leader
 * of its own process group. Its descendants are polled from spawn to close (`pollDescendants`); input stays open until
 * the result's reading, then EOF. Cleanup stops the remaining group and every descendant seen. A helper that detaches
 * (`setsid`) between two readings is not owned; this is cooperative, not OS containment.
 */
export async function headlessTurn(input: HeadlessTurnInput): Promise<HeadlessReply> {
	input.signal.throwIfAborted();
	checkRunnerCommunication(input.runner, input.communication);
	return withCommunicationConfig(input.communication, (args) =>
		runHeadlessTurn({ ...input, args: [...input.args, ...args] }),
	);
}

async function runHeadlessTurn(input: HeadlessTurnInput): Promise<HeadlessReply> {
	if (input.signal.aborted) throw abortError(input.signal);
	const args = [
		...input.args,
		...headlessPermissionArgs(path.resolve(input.cwd) !== path.resolve(input.sessionCwd)),
		...(input.model ? ["--model", input.model] : []),
	];
	await prepareTree();
	if (input.signal.aborted) throw abortError(input.signal);
	const child = spawn(input.command, args, {
		cwd: input.cwd,
		env: agentEnv(input.runner),
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	adoptTree(child.pid);
	const reader = new StreamReader(input);
	let stderr = "";
	const descendants = pollDescendants(child.pid);
	let closing: Promise<void> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<HeadlessReply>((resolve, reject) => {
			onAbort = () => reject(abortError(input.signal));
			input.signal.addEventListener("abort", onAbort, { once: true });
			if (input.signal.aborted) onAbort();
			child.once("spawn", () => {
				if (child.pid !== undefined) input.onStart?.(child.pid);
			});
			child.on("error", reject);
			child.stdin.on("error", () => undefined); // An early exit closes stdin; its exit code says why.
			child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: input.text } })}\n`);
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
			});
			const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
			lines.on("line", (line) => {
				reader.line(line);
				if (!reader.result || closing) return;
				// One more reading before the input closes, so the CLI's helpers are known when it exits.
				closing = descendants.snapshot().then(() => void child.stdin.end());
			});
			child.once("close", (code) => {
				try {
					resolve(reader.reply(code, stderr));
				} catch (error) {
					reject(error);
				}
			});
		});
	} finally {
		if (onAbort) input.signal.removeEventListener("abort", onAbort);
		await stopTree(child.pid, KILL_GRACE_MS, await descendants.stop());
		child.stdin.destroy();
	}
}
