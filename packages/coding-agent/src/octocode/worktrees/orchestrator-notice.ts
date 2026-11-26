import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { FeatureSetup } from "../../core/features/index.ts";
import { repoKey, workspaceGit } from "../../utils/git-repository.ts";
import { BACKLOG_DONE_CHANNEL, type BacklogDone } from "../shared/agent-chain.ts";
import { recordedCreator } from "./proxy.ts";

/** What the notice needs of the team: its live members, and a send that returns a refusal as `error`. */
export interface NoticeTeam {
	members(): Member[];
	send(to: string | undefined, text: string): Promise<{ error?: string } | object>;
}

/** The longest summary the notice carries: the orchestrator reads the item for the rest. */
const SUMMARY_CHARS = 200;

/**
 * The team member a linked worktree session reports to: the live main session that created its worktree, else the
 * oldest live main session in the main checkout `main`. Sessions in other linked worktrees are never picked.
 * Undefined when none runs.
 */
export function orchestratorMember(members: readonly Member[], main: string, creator?: string): Member | undefined {
	const mains = members.filter(
		(member) => member.role === "main" && !member.parentId && member.status !== "settled" && member.checkout === main,
	);
	return mains.find((member) => member.id === creator) ?? mains.sort((a, b) => a.joinedAt - b.joinedAt)[0];
}

/**
 * In a linked worktree session, tells the orchestrator when a backlog item finishes: one short team message, so its
 * merge handoff is not left unread. Other sessions send nothing. A failed send is shown to the model as a notice.
 */
export function registerOrchestratorNotice(
	api: Pick<FeatureSetup, "bus" | "channels">,
	team: NoticeTeam,
	notify: (text: string) => void,
): void {
	let folder: string | undefined;
	api.bus.on("session_start", async (_event, ctx) => void (folder = ctx.cwd));
	api.channels.on(BACKLOG_DONE_CHANNEL, (value) => {
		const git = folder ? workspaceGit(folder) : undefined;
		if (!folder || !git?.linkedWorktree) return;
		const checkout = repoKey(folder).root;
		const target = orchestratorMember(team.members(), path.dirname(git.commonDir), recordedCreator(checkout));
		if (!target) return;
		const { ref, summary } = value as BacklogDone;
		const text = `${ref} is done in the linked worktree ${checkout}: ${summary.slice(0, SUMMARY_CHARS)} Merge handoff: it is waiting on its branch there.`;
		void team.send(target.id, text).then((result) => {
			if ("error" in result && result.error)
				notify(`Could not tell the orchestrator ${target.id} that ${ref} is done: ${result.error}`);
		});
	});
}
