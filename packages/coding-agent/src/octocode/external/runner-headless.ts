import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { adoptTree, KILL_GRACE_MS, prepareTree, reapWithParent, stopTree } from "../shared/process.ts";
import { pollDescendants } from "../shared/descendant-poller.ts";
import { runnerLaunchArgs } from "./runner-isolation.ts";
import { agentEnv } from "./runner-env.ts";
import type { RunnerBilling } from "./runners.ts";
import { checkRunnerCommunication, type RunnerCommunication, withCommunicationConfig } from "./runner-communication.ts";
import { HEADLESS_ARGS } from "./headless/claude.ts";
import { headlessRoute } from "./headless/routes.ts";
import { isSessionId } from "./headless/common.ts";
import { type HeadlessReply, HeadlessSignedOut, type HeadlessRoute, type ResumeArgs } from "./headless/types.ts";

export { HEADLESS_ARGS, type HeadlessReply, HeadlessSignedOut };

/**
 * A task runs in the vendor's own CLI, headless, when the runner has no ACP adapter to connect: the route table
 * (`headless/routes.ts`) holds each CLI's argv, permission mapping and event parser, and this file owns the process:
 * environment, process group, descendants, cancellation and the idle timer.
 */

/** The `/providers` runner row's word for the Claude Code route. */
export const HEADLESS_ROUTE = "headless (adapter missing)";

/** The parts of a runner's checked state the route depends on (structural, so `runner-status.ts` can import this file). */
interface RouteState {
	id: string;
	cli: boolean;
	adapter: boolean;
	auth?: { signedIn: boolean };
}

/** Whether `state` runs headless: its CLI is installed and signed in, its adapter is missing, and it has an enabled route. */
export const headlessReady = (state: RouteState): boolean => headlessAvailable(state) && state.auth?.signedIn === true;

/** Whether the installed CLI has an enabled headless route, before its sign-in is checked. */
export const headlessAvailable = (state: RouteState): boolean =>
	headlessRoute(state.id)?.enabled === true && state.cli && !state.adapter;

/** The route a runner's row names when it is not the ACP adapter; undefined for the adapter route or none. */
export const runnerRoute = (state: RouteState): string | undefined =>
	headlessReady(state) ? headlessRoute(state.id)?.label : undefined;

/** What a headless turn needs; `awake` restarts the caller's idle timer on every event. */
export interface HeadlessTurnInput {
	runner: string;
	command: string;
	/** The route's fixed arguments (`launchOf` takes them from the table). */
	args: readonly string[];
	billing?: RunnerBilling;
	model?: string;
	communication?: RunnerCommunication;
	cwd: string;
	/** The session's own folder: a task elsewhere runs in its worktree. */
	sessionCwd: string;
	text: string;
	/** The caller is a read-only role: the task may not change files, so a route that cannot promise that refuses it. */
	readOnly?: boolean;
	/** The CLI's own session id an earlier turn reported: this turn continues that session. */
	resume?: string;
	signal: AbortSignal;
	onActivity(line: string): void;
	onStart?(pid: number): void;
	awake(): void;
}

/** The most of stderr kept for a failure message: the tail says why it exited. */
const STDERR_TAIL = 8 * 1024;

const abortError = (signal: AbortSignal): Error =>
	signal.reason instanceof Error ? signal.reason : new Error("Runner turn cancelled");

/** The route's arguments for continuing the session `sessionId`, or the refusal: an unchecked id never reaches argv. */
function resumeOf(route: HeadlessRoute, sessionId: string): ResumeArgs {
	if (!isSessionId(sessionId))
		throw new Error(`${route.id} cannot resume "${redactSecrets(sessionId)}": not a session id.`);
	const resume = route.resume(sessionId);
	if ("refuse" in resume) throw new Error(`${route.id} cannot resume its session: ${resume.refuse}`);
	return resume;
}

/** The route a task may run through, or why it may not: a disabled route, or a scope the route refuses. */
export function resolveHeadless(
	input: Pick<HeadlessTurnInput, "runner" | "cwd" | "sessionCwd" | "model" | "readOnly" | "resume">,
): {
	route: HeadlessRoute;
	args: string[];
	/** The arguments that end the argv: a resumed session's subcommand. */
	trailing: string[];
	env: Record<string, string>;
} {
	const route = headlessRoute(input.runner);
	if (!route?.enabled) throw new Error(`${input.runner} has no headless route a task may run through.`);
	const isolated = path.resolve(input.cwd) !== path.resolve(input.sessionCwd);
	const permission = route.permission({ isolated, readOnly: input.readOnly === true });
	if ("refuse" in permission) throw new Error(`${input.runner} cannot run this task headless: ${permission.refuse}`);
	const resume = input.resume === undefined ? undefined : resumeOf(route, input.resume);
	return {
		route,
		args: [...permission.args, ...(input.model ? route.model(input.model) : []), ...(resume?.args ?? [])],
		trailing: resume?.trailing ?? [],
		env: { ...route.env, ...permission.env },
	};
}

/**
 * One task's turn in a vendor CLI: started in the task's folder with the cleaned environment (`agentEnv`), as the
 * leader of its own process group. Its descendants are polled from spawn to close (`pollDescendants`); a held-open input
 * ends after the result's reading. Cleanup stops the remaining group and every descendant seen. A helper that detaches
 * (`setsid`) between two readings is not owned; this is cooperative, not OS containment.
 */
export async function headlessTurn(input: HeadlessTurnInput): Promise<HeadlessReply> {
	input.signal.throwIfAborted();
	checkRunnerCommunication(input.runner, input.communication);
	const resolved = resolveHeadless(input);
	if (input.communication && !resolved.route.communication)
		throw new Error(`${input.runner} has no verified communication bridge in its headless route.`);
	return withCommunicationConfig(input.communication, (extra) =>
		runHeadlessTurn(input, resolved, [...input.args, ...extra, ...resolved.args, ...resolved.trailing]),
	);
}

async function runHeadlessTurn(
	input: HeadlessTurnInput,
	{ route, env }: ReturnType<typeof resolveHeadless>,
	args: string[],
): Promise<HeadlessReply> {
	if (input.signal.aborted) throw abortError(input.signal);
	// The task text rides on stdin where the CLI reads it there, so its length and any secret in it never reach argv.
	const isolatedArgs = runnerLaunchArgs(input.runner, args);
	const argv = route.task === "argv" ? [...isolatedArgs, "--", input.text] : isolatedArgs;
	await prepareTree();
	if (input.signal.aborted) throw abortError(input.signal);
	const child = spawn(input.command, argv, {
		cwd: input.cwd,
		env: { ...agentEnv(input.runner), ...env },
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	adoptTree(child.pid);
	reapWithParent(child.pid);
	// The task folder as given and as the CLI sees it (symlinks resolved): its paths show relative to it.
	const roots = [path.resolve(input.cwd)];
	try {
		roots.push(realpathSync(input.cwd));
	} catch {
		// A folder that cannot be resolved shows its paths in full.
	}
	const parser = route.parser({
		runner: input.runner,
		billing: input.billing,
		roots,
		onActivity: (line) => input.onActivity(line),
	});
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
			if (route.task === "json")
				child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: input.text } })}\n`);
			else if (route.task === "text") child.stdin.end(input.text);
			else child.stdin.end();
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
			});
			const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
			lines.on("line", (raw) => {
				input.awake();
				let event: unknown;
				try {
					event = JSON.parse(raw);
				} catch {
					return; // A line that is not an event (a warning) is not part of the answer.
				}
				if (!isRecord(event)) return;
				parser.line(event);
				if (!parser.done || closing) return;
				// Readings turn frequent, and one more runs before the input closes, so the CLI's late helpers are known when it exits.
				descendants.hurry();
				closing = descendants.snapshot().then(() => void child.stdin.end());
			});
			child.once("close", (code) => {
				try {
					resolve(parser.reply(code, stderr));
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
