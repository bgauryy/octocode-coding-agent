import { type ConditionSpec, fields, text } from "./types.ts";

type Agent = { kind: "agent"; name: string };

/** `agent`: the named agent of this team has ended (its presence row was retired); the notice says why. */
export const agentSpec: ConditionSpec<Agent> = {
	kind: "agent",
	parse: (value) => ({ kind: "agent", name: text(fields(value, "agent", ["name"]).name, "until.agent.name") }),
	encode: (condition) => JSON.stringify({ name: condition.name }),
	decode(stored) {
		const { name } = JSON.parse(stored) as { name?: unknown };
		return typeof name === "string" ? { kind: "agent", name } : undefined;
	},
	describe: (condition) => `agent ${condition.name} ended`,
	safetyMs: 60_000,
	pollMs: 15_000,
	async check(condition, { deps }) {
		const end = deps.agentEnd(condition.name);
		if (!end) return { met: false, exit: null, output: `${condition.name} is still running.` };
		return {
			met: true,
			exit: null,
			output: `${condition.name} ended: ${end.reason}${end.detail ? ` (${end.detail})` : ""}`,
		};
	},
	watch: (_condition, { deps }, poke) => deps.watchDatabase(poke),
};
