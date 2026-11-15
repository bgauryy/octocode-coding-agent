/**
 * `/providers` External agents: the vendor CLIs that run `agent` tasks with their own sign-in (Claude Code, Codex CLI,
 * OpenCode, Gemini CLI). Each row says whether the CLI and its ACP adapter are installed, its version against the one
 * checked, and whether it is signed in, from the CLI's own status command (cached until its sign-in files change). The
 * list starts nothing: a runner is checked when its own page opens, and that answer is what the list shows next time.
 * Sign-in hands the terminal to the vendor's own login: Octocode reads nothing back and stores nothing of it.
 */

import { spawn } from "node:child_process";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { findOnPath } from "../../../../../common/src/find-on-path.ts";
import { agentEnv } from "../../../octocode/external/runner-env.ts";
import { runnerRoute } from "../../../octocode/external/runner-headless.ts";
import { checkRunners, isConnected, listRunners, type RunnerState } from "../../../octocode/external/runner-status.ts";
import { RUNNERS, runnerSpec } from "../../../octocode/external/runners.ts";
import { holdTerminalForChild } from "../../../utils/foreground-child.ts";
import { keyText } from "../../../theme/theme-tui-helpers.ts";
import type { PageRow, PageSection } from "../../../theme/manage-page.ts";
import type { ProviderSourceEnvironment } from "../../../core/provider-sources/types.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { showPage } from "./provider-ui.ts";

const RUNNER_ROW = "runner";
const runnerRowId = (id: string): string => `${RUNNER_ROW}:${id}`;

/** What each vendor CLI's own sign-in can pay with: the reason to pick it in **+ Add a provider**. */
const RUNNER_PLANS: Record<string, string> = {
	"claude-code": "Claude Pro/Max subscription or its own API key",
	codex: "ChatGPT subscription or its own API key",
	opencode: "its own sign-ins and providers",
	gemini: "Google AI Pro/Ultra subscription or its own API key",
};

/**
 * The **+ Add a provider** entries for vendor CLIs. They are external agents, not providers: the vendor's own CLI runs
 * each task in its own harness, so its plan is used where Octocode's harness may not use it.
 */
export const externalAgentSignIns = (): { id: string; name: string; detail: string }[] =>
	RUNNERS.map((spec) => ({
		id: runnerRowId(spec.id),
		name: spec.name,
		detail: `external agent · its own harness · ${RUNNER_PLANS[spec.id] ?? "its own sign-in"}`,
	}));

/** How a finished terminal command ended, or why it could not start. */
type TerminalExit = { code: number | null } | { error: string };
export type RunInTerminal = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<TerminalExit>;

/** Runs `command` with the terminal handed to it, as the external editor does; Ctrl+C belongs to the child. */
async function spawnInTerminal(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<TerminalExit> {
	const release = holdTerminalForChild();
	try {
		return await new Promise<TerminalExit>((resolve) => {
			const child = spawn(command, [...args], { stdio: "inherit", env, shell: process.platform === "win32" });
			child.on("error", (error) => resolve({ error: errorMessage(error) }));
			child.on("close", (code) => resolve({ code }));
		});
	} finally {
		release();
	}
}

const signIn = (state: RunnerState): string =>
	state.checkedAt === undefined
		? "not checked · open to check"
		: !state.auth
			? `sign-in unknown${state.error ? ` (${state.error})` : ""}`
			: state.auth.signedIn
				? `signed in${state.auth.method ? ` · ${state.auth.method}` : ""} · ${state.auth.billing === "metered" ? "metered key" : state.auth.billing === "plan" ? "plan" : "billing unknown"}`
				: "signed out";

function row(state: RunnerState, enabled: boolean): PageRow {
	const spec = runnerSpec(state.id);
	const version = state.version ? `${state.version}${state.untested ? ` (checked from ${spec?.tested})` : ""}` : "";
	// Every runner is a vendor CLI: its row names that kind first, as a provider row names its own.
	const detail = !state.cli
		? `CLI · not installed · ${spec?.cli} not on PATH`
		: [
				"CLI",
				version,
				runnerRoute(state) ?? (state.adapter ? "" : `adapter ${spec?.adapter.command} missing`),
				signIn(state),
			]
				.filter(Boolean)
				.join(" · ");
	const connected = isConnected(state);
	return {
		id: runnerRowId(state.id),
		name: state.name,
		detail,
		// Connected but not used: `externalAgents` is off, so no task starts in it. The badge says so.
		badge: connected
			? enabled
				? "connected"
				: "connected · off for tasks"
			: state.cli
				? state.auth?.signedIn === false
					? "signed out"
					: "not ready"
				: "absent",
		tone: connected ? "success" : state.cli ? "warning" : "muted",
	};
}

/** The environment runners are looked up and checked in: the page's own (tests point it at a temporary home), else this process's. */
const runnerEnvironment = (source: ProviderSourceEnvironment | undefined): NodeJS.ProcessEnv => ({
	...(source?.env ?? process.env),
	...(source?.home ? { HOME: source.home, USERPROFILE: source.home } : {}),
});

/**
 * Every known runner as last checked, read without starting anything: the main page opens at once. A failure is
 * reported through `onError` and lists no runner, so the page still opens.
 */
export function listedRunners(
	source: ProviderSourceEnvironment | undefined,
	onError: (message: string) => void,
): RunnerState[] {
	try {
		return listRunners(runnerEnvironment(source), source?.agentDir);
	} catch (error) {
		onError(`Could not list the external agents: ${errorMessage(error)}`);
		return [];
	}
}

/**
 * One runner, checked now (its own commands run only when something changed since its last check, or on `refresh`).
 * A runner's own failure is recorded on its state; anything else is reported through `onError`, and the page renders.
 */
async function checkRunner(
	id: string,
	source: ProviderSourceEnvironment | undefined,
	refresh: boolean,
	onError: (message: string) => void,
): Promise<RunnerState | undefined> {
	try {
		const [state] = await checkRunners({
			ids: [id],
			refresh,
			signal: AbortSignal.timeout(30_000),
			env: runnerEnvironment(source),
			...(source?.agentDir ? { agentDir: source.agentDir } : {}),
		});
		return state;
	} catch (error) {
		onError(`Could not check ${runnerSpec(id)?.name ?? id}: ${errorMessage(error)}`);
		return undefined;
	}
}

/** The External agents section of the main page; the setting's state is its empty text when nothing is installed. */
export function runnerSection(
	states: readonly RunnerState[],
	enabled: boolean,
	selected?: readonly string[],
): PageSection {
	return {
		heading: "External agents",
		rows: states.map((state) => row(state, enabled && (selected === undefined || selected.includes(state.id)))),
		empty: enabled ? "no vendor CLI found" : "off (externalAgents)",
	};
}

/** What a runner's page uses of the interactive host. */
type RunnerPageHost = Pick<ProviderManagerHost, "session" | "ui" | "showStatus" | "showError" | "showSelector">;

/** A fresh selection opts in one CLI; an explicit legacy all-runners setting keeps the other known CLIs. */
export function setRunnerEnabled(page: RunnerPageHost, id: string, enabled: boolean): void {
	const settings = page.session.settingsManager;
	const selected =
		settings.getEnabledExternalAgents() ?? (settings.getExternalAgents() ? RUNNERS.map((runner) => runner.id) : []);
	settings.setEnabledExternalAgents(enabled ? [...selected, id] : selected.filter((runner) => runner !== id));
	if (enabled) settings.setExternalAgents(true);
	page.showStatus(
		`${runnerSpec(id)?.name ?? id} ${enabled ? "enabled" : "disabled"} for agent tasks. Run /reload to apply.`,
	);
}

/** Report the runner's sign-in after a login or fresh check; changing task availability is a separate user action. */
function reportCheck(page: Pick<RunnerPageHost, "showStatus">, name: string, now: RunnerState): void {
	page.showStatus(`${name}: ${signIn(now)}.`);
}

/**
 * One runner's page: its facts, its own login, a fresh check, and the `externalAgents` setting that lets new sessions
 * start tasks in connected runners. Returns `again` to show the main page.
 */
export async function showRunnerDetail(
	page: RunnerPageHost,
	id: string,
	states: RunnerState[],
	options: { source?: ProviderSourceEnvironment; run?: RunInTerminal } = {},
): Promise<"again"> {
	const spec = runnerSpec(id);
	const listed = states.find((entry) => entry.id === id);
	if (!spec || !listed) return "again";
	// Opening the page is the check: the vendor's own commands run here, never while the list opens.
	if (listed.cli && listed.checkedAt === undefined) page.showStatus(`Checking ${spec.name}…`);
	const reportError = (message: string) => page.showError(message);
	const state =
		listed.cli && listed.checkedAt === undefined
			? ((await checkRunner(id, options.source, false, reportError)) ?? listed)
			: listed;
	const settings = page.session.settingsManager;
	const enabled = settings.getExternalAgents();
	const selected = settings.getEnabledExternalAgents();
	const active = enabled && (selected === undefined || selected.includes(id));
	const actions = new Map<string, () => Promise<void> | void>();
	const env = runnerEnvironment(options.source);
	const cli = findOnPath(spec.cli, env);
	if (!cli)
		actions.set(`Install ${spec.name}: ${spec.cli} is not on PATH`, () =>
			page.showStatus(`Install ${spec.name}, then open /providers again.`),
		);
	if (!state.adapter)
		actions.set(`Install its ACP adapter: ${spec.adapter.install}`, () =>
			page.showStatus(`Run ${spec.adapter.install}, then open /providers again.`),
		);
	if (cli)
		actions.set(`Sign in with ${spec.name}'s own login (${[spec.cli, ...spec.login].join(" ")})`, async () => {
			page.ui.stop();
			let exit: TerminalExit;
			try {
				// The restore sequences `stop` queued reach the terminal before this line and the vendor's CLI.
				await page.ui.terminal?.drainOutput?.();
				process.stdout.write(
					`Running \`${[spec.cli, ...spec.login].join(" ")}\`: finish the sign-in, then exit it. Octocode reads nothing of it.\n\n`,
				);
				exit = await (options.run ?? spawnInTerminal)(cli, spec.login, agentEnv(spec.id, env));
			} finally {
				page.ui.start();
				page.ui.requestRender(true);
			}
			if ("error" in exit) page.showError(`Could not run ${spec.cli}: ${exit.error}`);
			const now = await checkRunner(id, options.source, true, reportError);
			if (now) reportCheck(page, spec.name, now);
		});
	actions.set("Check again", async () => {
		const now = await checkRunner(id, options.source, true, reportError);
		if (now) reportCheck(page, spec.name, now);
	});
	actions.set(active ? "Disable this CLI for agent tasks" : "Enable this CLI for agent tasks", () => {
		setRunnerEnabled(page, id, !active);
	});
	if (enabled || selected?.length) {
		actions.set(enabled ? "Pause all external agent tasks" : "Resume selected external agent tasks", () => {
			settings.setExternalAgents(!enabled);
			page.showStatus(`External agent tasks ${enabled ? "paused" : "enabled"}. Run /reload to apply.`);
		});
	}
	const choice = await showPage(page, {
		title: `${spec.name} — ${isConnected(state) ? "connected" : "not connected"}`,
		notes: [
			`${spec.name} is an external agent: its own harness runs each task with its own tools and sign-in; Octocode never reads its credentials.`,
			"Selection applies after /reload or restart. Your default model stays unchanged.",
		],
		facts: [
			{ label: "CLI", value: state.cli ? `${spec.cli}${state.version ? ` ${state.version}` : ""}` : "not installed" },
			{ label: "Checked with", value: spec.tested },
			{ label: "ACP adapter", value: state.adapter ? spec.adapter.command : `missing · ${spec.adapter.install}` },
			{ label: "Sign-in", value: signIn(state) },
			{ label: "Agent tasks", value: active ? "enabled · /reload applies changes" : "off · enable this CLI to use it" },
		],
		sections: [{ heading: "ACTIONS", rows: [...actions.keys()].map((label) => ({ id: label, name: label })) }],
		hints: [
			[keyText("tui.select.confirm"), "run", 0],
			[keyText("tui.select.cancel"), "back", 1],
		],
	});
	await (choice ? actions.get(choice.id) : undefined)?.();
	return "again";
}
