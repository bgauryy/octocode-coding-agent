import type { Member } from "@octocodeai/octocode-contracts/team";
import type { CommandContext } from "../../../core/features/index.ts";
import { badge } from "../../../theme/page-kit.ts";
import { say } from "../../shared/commands.ts";
import { showCommandPage } from "../../shared/page.ts";
import { firstLine } from "../../shared/util.ts";
import type { Team } from "../../team/session.ts";
import { type AgentDetail, agentDetail, agentDetailPageText } from "./content.ts";
import { findMember } from "./lookup.ts";

/** The page of one live agent, read fresh from the team. */
function read(team: Team, member: Member): AgentDetail {
	const { members, traffic } = team.snapshot();
	const live = members.find((candidate) => candidate.id === member.id) ?? member;
	const self = members.find((candidate) => candidate.id === team.id);
	return agentDetail({
		member: live,
		here: self?.checkout,
		now: Date.now(),
		details: team.audit.details([live]).get(live.id),
		traffic,
		reportPath: team.audit.recent(1, live.id)[0]?.reportPath,
	});
}

/** Shows the page (Escape goes back) or, without a UI, prints it. Returns after the user leaves. */
async function show(team: Team, member: Member, ctx: CommandContext, nested: boolean): Promise<void> {
	const detail = read(team, member);
	if (!ctx.hasUI) return say(ctx, agentDetailPageText(detail));
	const state = badge(detail.state);
	await showCommandPage(ctx.ui, {
		title: `Agent ${member.id} · ${state.text}`,
		facts: detail.facts.map(([label, value]) => ({ label, value })),
		sections: [],
		nested,
	});
}

/** `/agents <name>`: the page of the live agent the name picks, or the reason none is. */
export async function openAgent(team: Team, name: string, ctx: CommandContext): Promise<void> {
	const found = findMember(team.members(), name);
	if ("error" in found) return say(ctx, found.error, "warning");
	await show(team, found.member, ctx, false);
}

/** `/agents` in a session with a UI: a list to pick an agent from; Escape on its page returns here. */
export async function pickAgent(team: Team, ctx: CommandContext): Promise<void> {
	let initialId: string | undefined;
	for (;;) {
		const { members } = team.snapshot();
		if (members.length === 0) return say(ctx, "No agents have joined in this repository.");
		const choice = await showCommandPage(ctx.ui, {
			title: "Agents",
			sections: [
				{
					heading: "Pick one to see what it does",
					rows: members.map((member) => {
						const shown = badge(member.status === "working" ? "ready" : "off");
						return {
							id: member.id,
							name: member.id,
							detail: `${member.role}${member.model ? ` · ${member.model}` : ""}${member.goal ? ` · ${firstLine(member.goal)}` : ""}`,
							badge: shown.text,
							tone: shown.tone,
						};
					}),
				},
			],
			...(initialId ? { initialId } : {}),
		});
		if (!choice) return;
		initialId = choice.id;
		const member = members.find((candidate) => candidate.id === choice.id);
		if (member) await show(team, member, ctx, true);
	}
}
