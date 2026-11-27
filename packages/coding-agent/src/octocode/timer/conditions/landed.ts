import path from "node:path";
import { needBacklog, splitList, staleHint, watchBacklog } from "./backlog-wait.ts";
import { parseSince } from "./changed.ts";
import { type BaseCondition, type ConditionSpec, fields, text } from "./types.ts";

type Landed = Extract<BaseCondition, { kind: "landed" }>;

const opt = (value: unknown, name: string): string | undefined => (value === undefined ? undefined : text(value, name));

/**
 * `landed`: the peer working on item `ref` is done with it. Met when the item is done or closed, the peer released it
 * (an audit change since the wait began), its reservation on `path` is released, or it ended (`agent`, or the item's holder, an agent id or a main
 * session id). The output says which. At the deadline, with the item still ongoing, it names the owner and
 * the question to ask.
 */
export const landedSpec: ConditionSpec<Landed> = {
	kind: "landed",
	parse(value) {
		const given = fields(value, "landed", ["ref", "path", "agent", "since"]);
		const ref = text(given.ref, "until.landed.ref");
		if (splitList(ref).length !== 1) throw new Error("until.landed.ref names one item: the peer's.");
		const pathText = opt(given.path, "until.landed.path");
		const agent = opt(given.agent, "until.landed.agent");
		const since = parseSince(given.since, "until.landed.since");
		return {
			kind: "landed",
			ref: splitList(ref)[0],
			...(pathText ? { path: pathText } : {}),
			...(agent ? { agent } : {}),
			...(since !== undefined ? { since } : {}),
		};
	},
	encode: (condition) => JSON.stringify(condition),
	decode(stored) {
		const parsed = JSON.parse(stored) as Record<string, unknown>;
		if (typeof parsed.ref !== "string") return undefined;
		return {
			kind: "landed",
			ref: parsed.ref,
			...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
			...(typeof parsed.agent === "string" ? { agent: parsed.agent } : {}),
			...(typeof parsed.since === "number" ? { since: parsed.since } : {}),
		};
	},
	describe: (condition) =>
		`${condition.ref} landed${condition.path ? ` or ${condition.path} released` : ""}${condition.agent ? ` or ${condition.agent} ended` : ""}`,
	safetyMs: 60_000,
	pollMs: 15_000,
	async check(condition, env) {
		const { deps, cwd } = env;
		const backlog = needBacklog(deps);
		const detail = backlog.detail(condition.ref);
		if (!detail)
			return { met: false, exit: null, output: "", refused: `no backlog item ${condition.ref} in this workspace` };
		const landed = (output: string) => ({ met: true, exit: null, output });
		if (detail.state === "done") return landed(`${condition.ref} is done.`);
		if (detail.state === "closed") return landed(`${condition.ref} is closed, not done.`);
		if (condition.since !== undefined) {
			const read = backlog.since(condition.since);
			const released = read.changes.find((change) => change.ref === condition.ref && change.kind === "released");
			if (released) return landed(`${condition.ref} was released by ${released.by}.`);
		}
		if (
			condition.path !== undefined &&
			deps.reservation(path.resolve(cwd, condition.path), condition.path) === undefined
		)
			return landed(`The reservation on ${condition.path} was released.`);
		const peer = condition.agent ?? detail.assignee ?? undefined;
		const end = peer === undefined ? undefined : deps.agentEnd(peer);
		if (peer !== undefined && end)
			return landed(`${peer} ended: ${end.reason}${end.detail ? ` (${end.detail})` : ""}.`);
		const hint = staleHint([condition.ref], env, condition.since);
		return {
			met: false,
			exit: null,
			output: `${condition.ref} is ${detail.state}${detail.assignee ? `, held by ${detail.assignee}` : ""}.${hint ? `\n${hint}` : ""}`,
		};
	},
	watch: (condition, { deps }, poke) => watchBacklog(deps, (change) => change.ref === condition.ref, poke, true),
};
