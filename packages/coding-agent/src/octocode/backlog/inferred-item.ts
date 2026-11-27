import { openBacklog } from "./context.ts";
import { heldOngoingItems } from "./held.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import { itemKey } from "../wake/gate.ts";

/**
 * The session's only ongoing item, which a background job without an `item` serves; undefined with none or several
 * (the job then stays unlinked), and when the backlog cannot be read (`backlog` reports that cause when asked).
 */
export function soleOngoingItem(ctx: Pick<FeatureContext, "cwd" | "sessionManager">): string | undefined {
	try {
		const backlog = openBacklog(ctx, { isSubagent: false });
		const mine = heldOngoingItems(backlog);
		const [only] = mine;
		return mine.length === 1 && only ? (itemKey(only.ref) ?? only.ref) : undefined;
	} catch {
		return undefined;
	}
}
