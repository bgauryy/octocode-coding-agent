import type { WorkLink } from "@octocodeai/octocode-contracts/backlogs";

/** `links` followed by each of `more` it does not already hold (same relation and target). */
export function mergeLinks(links: readonly WorkLink[], more: readonly WorkLink[]): WorkLink[] {
	const key = (link: WorkLink) => JSON.stringify([link.relation, link.target]);
	const seen = new Set(links.map(key));
	return [...links, ...more.filter((link) => !seen.has(key(link)) && seen.add(key(link)))];
}
