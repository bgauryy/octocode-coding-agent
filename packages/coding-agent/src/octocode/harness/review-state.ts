import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { refreshed } from "../guard/actions.ts";
import { knownReviews } from "../guard/registry.ts";
import { badge, type Review } from "../guard/types.ts";

/**
 * The security review state on `/harness` rows (terminal and web): each hook, MCP server or skill row the review knows
 * starts its detail with the same badge `/security` shows. `/harness` switches items; `/security` decides them.
 */
export function withReviewState(items: InventoryItem[]): InventoryItem[] {
	let reviews: Review[];
	try {
		reviews = refreshed(knownReviews());
	} catch {
		// The store cannot be read: the loaders already warned and loaded everything; the rows show no state.
		return items;
	}
	if (reviews.length === 0) return items;
	const byId = new Map<string, Review>();
	for (const review of reviews) {
		byId.set(review.item.id, review);
		// A folder skill's row names its folder; its review names SKILL.md.
		if (review.item.kind === "skill") byId.set(`skill:${review.item.path}`, review);
	}
	return items.map((item) => {
		const review = byId.get(item.id);
		return review ? { ...item, detail: `${badge(review)}${item.detail ? ` · ${item.detail}` : ""}` } : item;
	});
}
