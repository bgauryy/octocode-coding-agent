import { storedSecret } from "../../../../common/src/sanitize.ts";
import { BacklogError } from "./item.ts";

/** The text of one item that both exports (`/backlog export` and `/backlog html`) write. */
export interface ExportedItem {
	ref: string;
	title: string;
	goal?: string;
	body?: string;
	paths?: readonly string[];
	why?: string;
	evidence?: readonly string[];
	plan?: string;
	tags: readonly string[];
	assignee?: string;
	createdBy: string;
	sourceSession?: string;
	links?: unknown;
	completions?: unknown;
	notes: ReadonlyArray<{ text: string; author: string }>;
}

/**
 * Refuses an export with a credential-looking string in the repository name or any item text it carries, naming the
 * item and field. Writes are already refused (`refuseSecrets`); this checks again what the file will carry, so text
 * stored before that check, or by another build, never lands in a file that is easy to share. `extra` adds an item's
 * export-only entities (the page's comments and audit rows) to the entity check. `command` is named in the refusal.
 */
export function refuseExportSecrets<T extends ExportedItem>(
	repo: string,
	items: Iterable<T>,
	command: string,
	extra: (item: T) => Record<string, unknown> = () => ({}),
): void {
	const found = storedSecret({ repository: repo });
	if (found) throw new BacklogError(`Not written: the repository name ${found.problem.replace(/^it /, "")}.`);
	for (const item of items) {
		const { title, goal, body, paths, why, evidence, plan, tags, assignee, createdBy, sourceSession, notes } = item;
		const noteFields = notes.flatMap(
			(note, index) =>
				[
					[`note ${index + 1}`, note.text],
					[`note ${index + 1} author`, note.author],
				] as const,
		);
		const hit = storedSecret({
			title,
			goal,
			body,
			paths,
			why,
			evidence,
			plan,
			tags,
			assignee,
			createdBy,
			sourceSession,
			...Object.fromEntries(noteFields),
		});
		if (hit)
			throw new BacklogError(
				`Not written: the ${hit.name} of ${item.ref} ${hit.problem.replace(/^it /, "")}. Remove it from the item, or delete the item, and run ${command} again.`,
			);
		const entities = JSON.stringify({ links: item.links, completions: item.completions, ...extra(item) });
		if (storedSecret({ entities })) throw new BacklogError(`Not written: ${item.ref} contains unsafe entity text.`);
	}
}
