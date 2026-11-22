import path from "node:path";
import { closeSharedAgentDb } from "../../../../db/src/api.ts";
import type { FeatureSetup } from "../../../src/core/features/index.ts";
import { BACKLOG_PEER_TYPE, type PeerWake } from "../../../src/octocode/backlog/peer-notify.ts";
import { registerBacklog } from "../../../src/octocode/backlog/index.ts";
import { openBacklog } from "../../../src/octocode/backlog/context.ts";
import { Subcommands } from "../../../src/octocode/shared/commands.ts";
import { wakeGateOf } from "../../../src/octocode/wake/gate.ts";
import { tmp } from "../helpers.ts";
import { createRig, type Rig, type RigOptions } from "./rig.ts";

/**
 * A rig whose session runs the real backlog feature (the audit-log feed, the peer notifier) wired to the real wake gate
 * exactly as `compose-backlog.ts` wires it, in a private agent database. Restore with `restoreBacklogEnv` after each test.
 */
const saved = process.env.OCTOCODE_AGENT_DB;

export function restoreBacklogEnv(): void {
	closeSharedAgentDb();
	if (saved === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = saved;
}

/** The completion a `done` needs. */
export const completion = (key: string) => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: key,
});

export async function backlogRig(options: RigOptions & { also?: (api: FeatureSetup) => void } = {}) {
	const db = path.join(tmp(), "octocode.db");
	process.env.OCTOCODE_AGENT_DB = db;
	const { also, register, ...rest } = options;
	const rig: Rig = await createRig({
		...rest,
		register: (api) => {
			registerBacklog(api, {
				commands: new Subcommands(),
				isSubagent: false,
				wakes: {
					acted: (ref) => wakeGateOf(api).actedOn(ref),
					send: (wake: PeerWake) =>
						wakeGateOf(api).emit(
							{
								kind: "item.peer",
								ref: wake.ref,
								change: wake.kind,
								by: wake.by,
								relation: wake.relation,
								id: wake.id,
							},
							{ customType: BACKLOG_PEER_TYPE, content: wake.content, display: false },
							{ triggerTurn: true, deliverAs: "followUp" },
						),
				},
			});
			also?.(api);
			register?.(api);
		},
	});
	const { store } = openBacklog(rig.ctx, { isSubagent: false });
	return { rig, store, session: rig.ctx.sessionManager.getSessionId(), db };
}
