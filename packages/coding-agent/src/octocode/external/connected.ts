import { matchesExternalModel, type ExternalModelFilters } from "../shared/model-filters.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import type { AcpPermission } from "../../../../acp/src/client/client.ts";
import { GLYPH } from "@octocodeai/octocode-tui/text";
import { listRunners, type RunnerState } from "./runner-status.ts";
import { headlessAvailable } from "./runner-headless.ts";
import { runnerSupportsCommunication } from "./runner-communication.ts";
import { type RunnerTurnInput, runnerTurn, runnerTurnDeps } from "./runner-session.ts";

/**
 * Installed runnable CLIs, read once when the tool is declared. No process starts for discovery;
 * a task checks its selected runner's sign-in before launch, retaining cached account metadata when valid.
 */
export function connectedRunners(
	enabled: boolean,
	permission: (ctx: FeatureContext) => AcpPermission,
	selected?: readonly string[],
) {
	const states = enabled
		? listRunners().filter(
				(state) =>
					(selected === undefined || selected.includes(state.id)) &&
					state.cli &&
					(state.adapter || headlessAvailable(state)),
			)
		: [];
	const ids = states.map((state) => state.id);
	const deps = runnerTurnDeps(permission);
	return {
		ids,
		communication: ids.filter(runnerSupportsCommunication),
		states,
		turn: (input: RunnerTurnInput) =>
			ids.includes(input.runner)
				? runnerTurn(input, deps)
				: Promise.reject(
						new Error(`Runner ${input.runner} is not enabled in this session. Select it in /providers, then /reload.`),
					),
	};
}

/** One runner as a `models` row: who it is, its version and how it is signed in and billed. */
const runnerRow = (state: RunnerState): string =>
	`  ${GLYPH.live} ${state.id} · ${[
		`${state.name}${state.version ? ` ${state.version}` : ""}`,
		state.auth?.signedIn === false
			? "signed out"
			: state.auth?.signedIn
				? (state.auth.method ?? "signed in")
				: state.checkedAt
					? "sign-in unknown; checked when used"
					: "sign-in checked when used",
		state.auth?.billing === "metered" ? "metered key" : state.auth?.billing === "plan" ? "plan" : "billing unknown",
	]
		.filter(Boolean)
		.join(" · ")}`;

/** The `models` block for the session's connected runners; empty without one. */
export function runnerRows(states: readonly RunnerState[], filters?: ExternalModelFilters): string[] {
	const shown = states.filter((state) => matchesExternalModel(filters, state.id, `${state.id} ${state.name}`));
	if (shown.length === 0) return [];
	return [
		[
			"Installed runners: pass `runner` on a task to run it in that vendor's own CLI; sign-in is checked when used",
			...shown.map(runnerRow),
		].join("\n"),
	];
}
