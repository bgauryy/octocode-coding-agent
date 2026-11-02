import type { EntityInput, ItemType } from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import type { backlog } from "../agentdb/api.ts";

export interface AddInput extends EntityInput {
	note?: string;
	title: string;
	goal?: string;
	paths?: readonly string[];
	why?: string;
	evidence?: readonly string[];
	plan?: string;
	state?: State;
	priority?: number;
	tags?: readonly string[];
	/** The item this one came from (`B12`). */
	from?: string;
	createdBy: string;
	sourceSession?: string;
}

export interface UpdateInput extends EntityInput {
	title?: string;
	goal?: string;
	paths?: readonly string[];
	why?: string;
	evidence?: readonly string[];
	plan?: string;
	state?: State;
	priority?: number;
	tags?: readonly string[];
	/** The item this one came from (`B12`); null clears the link. */
	from?: string | null;
	note?: string;
	/** Refuse when the item changed since this version was read (a board holding a stale copy). */
	version?: number;
	/** The user's own edit: may change an item another live session holds (claiming it is still refused). */
	force?: boolean;
}

/** Which items to list; every set field must hold, and a list field matches when any entry does. */
export interface ListQuery {
	states?: readonly State[];
	query?: string;
	/** Only the items that came from this one (`B12`). */
	from?: string;
	/** Item ids (`B12`). */
	ids?: readonly string[];
	/** Text whose words all appear in the title. */
	title?: string;
	/** The items under this one (`B3`), at any depth. */
	parentId?: string;
	types?: readonly ItemType[];
	/** Priorities up to this one (0 is the most urgent). */
	maxPriority?: number;
	tags?: readonly string[];
	/** Prefixes of an item's paths. */
	paths?: readonly string[];
	/** Items that depend on one of these (`B12`). */
	dependsOn?: readonly string[];
	/** true: waits on a prerequisite that is missing or not done; false: none. */
	blocked?: boolean;
	/** Session ids holding the item. */
	assignees?: readonly string[];
	/** Epoch milliseconds: updated at or after. */
	updatedSince?: number;
	/** Epoch milliseconds: created at or after. */
	createdSince?: number;
	sort?: backlog.ItemSort;
	limit?: number;
	offset?: number;
}
