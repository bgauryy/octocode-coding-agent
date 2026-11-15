import type { ExtensionContext } from "../../core/features/index.ts";
import { findOnPath } from "../../../../common/src/find-on-path.ts";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import type { AcpBackend, AcpConnectInput, AcpPermission, AcpTurnUpdate } from "../../../../acp/src/client/client.ts";
import { authRequiredIn } from "../../../../acp/src/client/auth.ts";
import { clip } from "../shared/text.ts";
import { connectAcp } from "./acp-host.ts";
import { HEADLESS_ARGS, headlessReady, HeadlessSignedOut, headlessTurn } from "./runner-headless.ts";
import {
	cachedRunners,
	checkRunners,
	forgetRunner,
	isConnected,
	listRunners,
	type RunnerState,
} from "./runner-status.ts";
import { adapterArgs, type RunnerBilling, runnerSpec } from "./runners.ts";
import { runnerLaunchArgs, runnerSessionMeta } from "./runner-isolation.ts";
import { checkRunnerCommunication, type RunnerCommunication } from "./runner-communication.ts";

/** A runner that streams nothing this long has stalled (a native child's idle limit is the same order). */
const RUNNER_IDLE_MS = 15 * 60_000;
/** The prompt itself has no deadline of its own: the idle limit and the caller's stop end it. */
const NO_DEADLINE_MS = 2 ** 31 - 1;

/** What a runner's turn needs: the task message, where it runs, and where its stream and permission requests go. */
export interface RunnerTurnInput {
	runner: string;
	model?: string;
	communication?: RunnerCommunication;
	cwd: string;
	text: string;
	signal: AbortSignal;
	onActivity(line: string): void;
	onStart?(pid: number): void;
	ctx: ExtensionContext;
}

type SessionUpdate = Parameters<AcpTurnUpdate>[0];

/** Where a runner's adapter is and how to start it; tests start the scripted ACP peer instead. */
export interface RunnerLaunch {
	command: string;
	args: string[];
	billing?: RunnerBilling;
	/** `headless`: the vendor CLI itself runs the turn (`runner-headless.ts`); absent: its ACP adapter does. */
	route?: "headless";
}

/**
 * How a connected runner's turn starts: its adapter, with the billing guard its login asks for (`adapterArgs`); or,
 * when Claude Code is signed in but its adapter is missing, its own CLI headless (RFC alternative D).
 */
export function launchOf(runner: string, states: readonly RunnerState[] = cachedRunners()): RunnerLaunch {
	const spec = runnerSpec(runner);
	const state = states.find((entry) => entry.id === runner);
	if (!spec || !state || !state.cli)
		throw new Error(`Runner ${runner} is not connected; connect it in /providers (External agents).`);
	if (state.auth?.signedIn === false)
		throw new Error(`${runner} is signed out: sign in with /providers (External agents), then start the task again.`);
	if (!state.auth)
		throw new Error(
			`${runner} sign-in could not be confirmed${state.error ? `: ${redactSecrets(state.error)}` : ""}. Check /providers (External agents), then retry.`,
		);
	const billing = state.auth?.billing;
	const command = findOnPath(spec.adapter.command);
	if (command) return { command, args: adapterArgs(spec, billing), billing };
	const cli = headlessReady({ ...state, adapter: false }) ? findOnPath(spec.cli) : undefined;
	if (cli) return { command: cli, args: [...HEADLESS_ARGS], billing, route: "headless" };
	throw new Error(`${spec.name}'s ACP adapter is not installed: ${spec.adapter.install}.`);
}

/** A tool call or plan the runner streams, as one short row line; text and thoughts are the answer, not activity. */
function activityLine(update: SessionUpdate): string | undefined {
	if (update.sessionUpdate === "tool_call")
		return `→ ${clip(redactSecrets(update.title || update.kind || "tool"), 120)}`;
	if (update.sessionUpdate === "plan") return `plan: ${update.entries.length} steps`;
	return undefined;
}

/** The dollar figure of the runner's last `usage_update`, when it sent one. */
function reportedCost(update: SessionUpdate): number | undefined {
	if (update.sessionUpdate !== "usage_update" || !update.cost) return undefined;
	return update.cost.currency === "USD" && Number.isFinite(update.cost.amount) ? update.cost.amount : undefined;
}

export interface RunnerTurnDeps {
	launch: (runner: string, signal: AbortSignal) => RunnerLaunch | Promise<RunnerLaunch>;
	connect: (input: AcpConnectInput, permission: AcpPermission, signal?: AbortSignal) => Promise<AcpBackend>;
	permission: (ctx: ExtensionContext) => AcpPermission;
}

/**
 * One task's turn in a runner: its adapter starts with the cleaned environment in the task's folder, the message goes
 * as one prompt, every tool call it streams reaches the row, and the connection (and the process tree it owns) closes
 * when the turn ends, fails or is stopped. A runner that answers `auth_required` is signed out: its cached check is
 * dropped so `/providers` checks it again.
 */
export async function runnerTurn(input: RunnerTurnInput, deps: RunnerTurnDeps) {
	input.signal.throwIfAborted();
	checkRunnerCommunication(input.runner, input.communication);
	const launch = await deps.launch(input.runner, input.signal);
	input.signal.throwIfAborted();
	const idle = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const awake = () => {
		clearTimeout(timer);
		timer = setTimeout(
			() => idle.abort(new Error(`${input.runner} sent nothing for ${RUNNER_IDLE_MS / 60_000} minutes`)),
			RUNNER_IDLE_MS,
		);
		timer.unref?.();
	};
	const signal = AbortSignal.any([input.signal, idle.signal]);
	let backend: AcpBackend | undefined;
	let cost: number | undefined;
	try {
		awake();
		if (launch.route === "headless")
			return await headlessTurn({
				...input,
				...launch,
				sessionCwd: input.ctx.cwd,
				signal,
				awake,
			});
		backend = await deps.connect(
			{
				command: launch.command,
				args: runnerLaunchArgs(input.runner, launch.args, input.communication?.name),
				vendor: input.runner,
				cwd: input.cwd,
				sessionMeta: runnerSessionMeta(input.runner),
				mcpServers: input.communication
					? [{ ...input.communication, type: "http", headers: [...input.communication.headers] }]
					: [],
				...(input.model ? { model: input.model } : {}),
			},
			deps.permission(input.ctx),
			signal,
		);
		if (backend.pid !== undefined) input.onStart?.(backend.pid);
		const reply = await backend.prompt(input.text, {
			timeoutMs: NO_DEADLINE_MS,
			signal,
			onUpdate: (update) => {
				awake();
				cost = reportedCost(update) ?? cost;
				const line = activityLine(update);
				if (line) input.onActivity(line);
			},
		});
		return {
			text: reply.text,
			...(reply.stopReason ? { stopReason: reply.stopReason } : {}),
			...(reply.usage ? { usage: reply.usage } : {}),
			...(cost !== undefined ? { cost } : {}),
			billing: launch.billing,
		};
	} catch (error) {
		if (authRequiredIn(error) || error instanceof HeadlessSignedOut) {
			await forgetRunner(input.runner);
			throw new Error(
				`${input.runner} is signed out: sign in with /providers (External agents), then start the task again.`,
				{
					cause: error,
				},
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		await backend?.close();
	}
}

/** Check only the selected runner on use; retry unknown or signed-out checks, reuse valid positive metadata. */
export const runnerTurnDeps = (permission: (ctx: ExtensionContext) => AcpPermission): RunnerTurnDeps => ({
	launch: async (runner, signal) => {
		signal.throwIfAborted();
		const known = listRunners().find((state) => state.id === runner);
		const states = await checkRunners({ ids: [runner], signal, refresh: !known || !isConnected(known) });
		signal.throwIfAborted();
		return launchOf(runner, states);
	},
	connect: connectAcp,
	permission,
});
