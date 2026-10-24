import type { EntityInput } from "@octocodeai/octocode-contacts/backlogs";
import type { State } from "@octocodeai/octocode-contacts/snapshot";

export interface AddInput extends EntityInput {
	note?: string;
	title: string;
	goal?: string;
	body?: string;
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
	body?: string;
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

export interface ListQuery {
	states?: readonly State[];
	query?: string;
	/** Only the items that came from this one (`B12`). */
	from?: string;
	limit?: number;
	offset?: number;
}
