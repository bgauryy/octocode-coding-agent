import type { FeatureSetup } from "../core/features/index.ts";
import { registerBacklog } from "./backlog/index.ts";
import type { CompletionGate } from "./backlog/completion-gate.ts";
import type { Holdings } from "./backlog/done-guard.ts";
import { BACKLOG_PEER_TYPE, type PeerWake } from "./backlog/peer-notify.ts";
import type { PeerWakes } from "./backlog/peers.ts";
import type { Subcommands } from "./shared/commands.ts";
import type { Team } from "./team/session.ts";
import { sessionNativeTools, startTrustedWorkspaceWeb } from "./workspace-web.ts";
import { teamView, WorkspaceRuntime } from "./workspace/runtime.ts";
import { registerWebCommands } from "./remote/register.ts";
import { getApplicationPortForSession } from "../core/application/index.ts";
import { wakeGateOf } from "./wake/gate.ts";
import { runningWorkOf } from "./shared/running-work.ts";
import { worktreesMadeFor } from "./subagents/worktree-owned.ts";
import { PARENT_HOLDS_LEASES_ENV } from "./team/store/env.ts";

/** The backlog's peer wakes go through the session's wake gate. */
function peerWakes(api: FeatureSetup): PeerWakes {
	return {
		acted: (ref) => wakeGateOf(api).actedOn(ref),
		send: (wake: PeerWake) =>
			wakeGateOf(api).emit(
				{ kind: "item.peer", ref: wake.ref, change: wake.kind, by: wake.by, relation: wake.relation, id: wake.id },
				{ customType: BACKLOG_PEER_TYPE, content: wake.content, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			),
	};
}

/**
 * What this session still runs for `done` to wait for: its running children, bash jobs and timers, its own reservations
 * and the worktrees it made. A child whose parent reserved its paths holds none of its own: the parent releases those.
 */
export function holdingsOf(
	api: FeatureSetup,
	team: Team,
	isSubagent: boolean,
	serving: () => Map<string, string>,
): Holdings {
	const parentReserved = isSubagent && process.env[PARENT_HOLDS_LEASES_ENV] === "1";
	return {
		children: serving,
		work: () => runningWorkOf(api).all(),
		locks: () => (parentReserved ? [] : (team.members().find((member) => member.id === team.id)?.locks ?? [])),
		worktrees: (ref, cwd) => worktreesMadeFor(cwd, ref),
	};
}

/** Registers the workspace, the backlog (team, hooks, wake gate and workspace web wired in) and the web commands, in that order. */
export function composeBacklog(
	api: FeatureSetup,
	options: {
		commands: Subcommands;
		isSubagent: boolean;
		team: Team;
		/** Stops a team member on the user's behalf; returns why it cannot. */
		stop: (to: string) => string | undefined;
		completing: CompletionGate;
		/** The backlog item each running child works on, by child name. */
		serving: () => Map<string, string>;
	},
): void {
	const { commands, isSubagent, team, stop, completing, serving } = options;
	const workspace = isSubagent
		? undefined
		: new WorkspaceRuntime(api, {
				application: (ctx) => getApplicationPortForSession(ctx.sessionManager.getSessionId()),
				...teamView(team, true),
				tell: (to, text, signal) => team.send(to, text, { from: "user", signal }),
				stop,
			});
	const backlogWeb = registerBacklog(api, {
		commands,
		isSubagent,
		agentId: () => team.id,
		reservations: () =>
			team
				.members()
				.filter((member) => member.id !== team.id)
				.map((member) => ({ agent: member.id, paths: member.locks ?? [] })),
		completing,
		holdings: holdingsOf(api, team, isSubagent, serving),
		wakes: peerWakes(api),
		openWeb: (ctx, backlog, changed) => startTrustedWorkspaceWeb(backlog, changed, workspace?.bind(ctx, backlog)),
	});
	if (!isSubagent)
		registerWebCommands(api, {
			commands,
			workspace,
			openWorkspace: backlogWeb.open,
			nativeTools: sessionNativeTools,
			boardChanged: backlogWeb.refresh,
		});
}
