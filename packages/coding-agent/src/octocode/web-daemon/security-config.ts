import { type SecurityAction, type SecurityItem, type SecurityList } from "@octocodeai/octocode-contracts/config";
import { decideOne, refreshed, SecurityCommandError } from "../guard/actions.ts";
import { collectReviews } from "./security-collect.ts";
import { renderChanges } from "../guard/diff.ts";
import { isWithheld } from "../guard/registry.ts";
import { sortReviews } from "../guard/report.ts";
import type { GuardOptions } from "../guard/store.ts";
import type { Review } from "../guard/types.ts";
import { visible } from "../guard/visible.ts";
import { ConfigWriteError } from "./config-write.ts";

export interface SecurityOptions {
	agentDir: string;
	/** The workspace whose items are listed; the agent directory when the page names none. */
	cwd?: string;
	guard?: GuardOptions;
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function itemOf(review: Review): SecurityItem {
	const { item } = review;
	return {
		id: item.id,
		kind: item.kind,
		label: cut(visible(item.label), 512),
		path: cut(visible(item.path), 2048),
		scope: item.scope === "global" ? "global" : "workspace",
		state: review.word,
		rating: review.rating,
		changed: review.changed,
		withheld: isWithheld(review),
		...(item.unreadable ? { unreadable: cut(visible(item.unreadable), 1024) } : {}),
		grants: item.grants.slice(0, 32).map((grant) => cut(visible(grant), 512)),
		findings: review.findings
			.slice(0, 200)
			.map((finding) => ({ rule: finding.rule, rating: finding.rating, text: cut(visible(finding.text), 2048) })),
		...(review.changed && review.approved
			? {
					changes: renderChanges(review.approved, item.files)
						.slice(0, 130)
						.map((line) => cut(line, 2048)),
				}
			: {}),
	};
}

async function load(options: SecurityOptions): Promise<{ reviews: Review[]; trusted: boolean }> {
	const found = await collectReviews(options.cwd ?? options.agentDir, options.agentDir);
	return { reviews: refreshed(found.reviews, options.guard), trusted: found.trusted };
}

const listOf = (reviews: readonly Review[], trusted: boolean, message?: string): SecurityList => ({
	items: sortReviews(reviews).map(itemOf),
	workspace: { trusted },
	...(message ? { message: cut(message, 500) } : {}),
});

/** The reviewed hooks, MCP servers and skills a session in the workspace would load, with their stored decisions. */
export async function listSecurity(options: SecurityOptions): Promise<SecurityList> {
	const { reviews, trusted } = await load(options);
	return listOf(reviews, trusted);
}

/**
 * Applies one `/security` verb to the item `id` through the guard's own action, then lists again. The decision is the
 * user's: the route is launch-capability only. Throws `ConfigWriteError` for an unknown item or a refusal.
 */
export async function actSecurity(id: string, action: SecurityAction, options: SecurityOptions): Promise<SecurityList> {
	const { reviews, trusted } = await load(options);
	const review = reviews.find((entry) => entry.item.id === id);
	if (!review) throw new ConfigWriteError(404, "Unknown item.", "unknown");
	let message: string;
	try {
		message = decideOne(review, action, "web", options.guard);
	} catch (error) {
		if (error instanceof SecurityCommandError) throw new ConfigWriteError(409, error.message.slice(0, 500), "refused");
		throw error;
	}
	return listOf(refreshed(reviews, options.guard), trusted, message);
}
