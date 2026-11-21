import type { AgentRuns } from "./claim.ts";
import { servedItems } from "./handed-items.ts";
import type { ItemLink } from "./item-link.ts";
import type { Lingering } from "./linger.ts";

/**
 * One child per item: a second one would race the first on its paths and its completion. A child that reported and
 * stays reachable still owns it, since a message continues it; `except` names the children this call continues or is.
 */
export function refuseSecondChild(
	runs: Pick<AgentRuns, "items" | "running" | "handed">,
	lingering: Pick<Lingering, "onItem">,
	linked: Pick<ItemLink, "ref"> | undefined,
	except: readonly (string | undefined)[],
): void {
	if (!linked) return;
	for (const [child, ref] of servedItems(runs))
		if (ref === linked.ref && !except.includes(child))
			throw new Error(`${ref} is being worked on by ${child}: message or resume it, or wait for its report.`);
	const parked = lingering.onItem(linked.ref);
	if (parked !== undefined && !except.includes(parked))
		throw new Error(
			`${linked.ref} is with ${parked}, which reported and stays reachable: resume it (\`resume\` ${parked}), or end it with \`coordinate\` action \`stop\` first.`,
		);
}

/**
 * Holds the item from a call's first check to its claim, so a later call of the same batch is refused at its own first
 * check, even when this call awaits longer before claiming (an isolated call lists saved refs first). The returned
 * function ends the hold; the claim, once taken, refuses later calls through `refuseSecondChild`.
 */
export function holdItem(
	runs: Pick<AgentRuns, "starting">,
	linked: Pick<ItemLink, "ref"> | undefined,
	call: string,
): () => void {
	if (!linked) return () => undefined;
	runs.starting ??= new Map();
	const starting = runs.starting;
	const earlier = starting.get(linked.ref);
	if (earlier !== undefined)
		throw new Error(
			`${linked.ref} is being worked on by the child call ${earlier} is starting: wait for its result, then message or resume that child.`,
		);
	starting.set(linked.ref, call);
	return () => {
		if (starting.get(linked.ref) === call) starting.delete(linked.ref);
	};
}
