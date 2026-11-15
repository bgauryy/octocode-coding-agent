import type { AgentRuns } from "./claim.ts";
import type { ItemLink } from "./item-link.ts";
import type { Lingering } from "./linger.ts";

/**
 * One child per item: a second one would race the first on its paths and its completion. A child that reported and
 * stays reachable still owns it, since a message continues it; `except` names the children this call continues or is.
 */
export function refuseSecondChild(
	runs: Pick<AgentRuns, "items" | "running">,
	lingering: Pick<Lingering, "onItem">,
	linked: Pick<ItemLink, "ref"> | undefined,
	except: readonly (string | undefined)[],
): void {
	if (!linked) return;
	for (const [child, ref] of runs.items)
		if (ref === linked.ref && !except.includes(child) && runs.running.has(child))
			throw new Error(`${ref} is being worked on by ${child}: message or resume it, or wait for its report.`);
	const parked = lingering.onItem(linked.ref);
	if (parked !== undefined && !except.includes(parked))
		throw new Error(
			`${linked.ref} is with ${parked}, which reported and stays reachable: resume it (\`resume\` ${parked}), or end it with \`coordinate\` action \`stop\` first.`,
		);
}
