import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { SkillListing } from "../../core/skills/listing.ts";
import { type CatalogSkill, closeNames, type SkillCatalog } from "./catalog.ts";
import { loadSkill, type SkillDetails } from "./load.ts";

/** Names listed when nothing is close to the requested one. */
const LISTED_NAMES = 20;

/** Why a requested skill did not load: it is not listed, the user keeps it, or its file could not be read. */
type SkillRefusalReason = "unknown" | "reserved" | "unreadable";

/** One requested skill that did not load, with the sentence the model reads. */
export interface SkillRefusal {
	request: string;
	reason: SkillRefusalReason;
	message: string;
}

/** One requested skill that loaded: the details its row shows and the `<skill>` block the model reads. */
export interface LoadedSkillBlock {
	details: SkillDetails;
	block: string;
}

/** What a batch call records beside its text: rows render it, compaction reads `loadedSkills`. */
export interface SkillBatchDetails {
	skills: SkillDetails[];
	refused: SkillRefusal[];
	loadedSkills: { name: string; location: string }[];
}

/**
 * `skill:name`, `/skill:name` and `/name` name the same skill as `name`: the forms users type. A listed path (it has a
 * separator past its first character) stays as written.
 */
export function skillReference(value: string): string {
	const trimmed = value.trim();
	if (trimmed.indexOf("/", 1) > 0) return trimmed;
	return trimmed.replace(/^\/?(?:skill:)?/, "");
}

/** The skills one `skill` call asks for: `names`, or the single `name` older sessions send; empty entries and repeats dropped. */
export function requestedSkills(params: { name?: string; names?: readonly string[] }): string[] {
	const all = [...(params.names ?? []), ...(params.name === undefined ? [] : [params.name])];
	return [...new Set(all.map(skillReference).filter(Boolean))];
}

function unknownSkill(request: string, listing: SkillListing): SkillRefusal {
	const names = listing.entries.map((entry) => entry.name);
	const close = closeNames(request, names);
	const message =
		names.length === 0
			? `Unknown skill "${request}": this session has no skill a model can load. Continue without one.`
			: close.length > 0
				? `Unknown skill "${request}". Close matches: ${close.join(", ")}.`
				: `Unknown skill "${request}". Available: ${names.slice(0, LISTED_NAMES).join(", ")}${names.length > LISTED_NAMES ? `, and ${names.length - LISTED_NAMES} more` : ""}.`;
	return { request, reason: "unknown", message };
}

/**
 * The outcome of one `skill` call: a loaded block or a refusal per requested skill, in request order. A request is
 * served only when it names a skill the catalog lists as loadable (by name or by listed path), so the tool is no way to
 * read another file, and one bad entry never costs the others.
 */
export class SkillBatch {
	readonly loaded: LoadedSkillBlock[] = [];

	readonly refused: SkillRefusal[] = [];

	static run(catalog: SkillCatalog, requests: readonly string[], session: { id: string; cwd: string }): SkillBatch {
		const batch = new SkillBatch();
		const all = catalog.refresh({ allowStale: false });
		const listing = SkillListing.of(all);
		const byFile = new Map(all.map((entry) => [entry.file, entry]));
		for (const request of requests) batch.serve(request, all, listing, byFile, session);
		return batch;
	}

	private serve(
		request: string,
		all: readonly CatalogSkill[],
		listing: SkillListing,
		byFile: ReadonlyMap<string, CatalogSkill>,
		session: { id: string; cwd: string },
	): void {
		const listed = listing.find(request);
		const entry = listed ? byFile.get(listed.path) : undefined;
		if (!entry) {
			const reserved = all.find(
				(candidate) =>
					candidate.skill.disableModelInvocation &&
					(candidate.skill.name.toLowerCase() === request.toLowerCase() || candidate.file === request),
			);
			this.refused.push(
				reserved
					? {
							request,
							reason: "reserved",
							message: `Skill "${reserved.skill.name}" is reserved for the user (disable-model-invocation); do not load it. Ask the user to run /skill:${reserved.skill.name} if it is needed.`,
						}
					: unknownSkill(request, listing),
			);
			return;
		}
		if (this.loaded.some((done) => done.details.location === entry.file)) return;
		try {
			const { block, details } = loadSkill(entry, session.id, session.cwd);
			this.loaded.push({ block, details });
		} catch (error) {
			this.refused.push({
				request,
				reason: "unreadable",
				message: `Skill "${entry.skill.name}" could not be read: ${errorMessage(error)}`,
			});
		}
	}

	/** The model's reply: each loaded block, then one line per refusal. */
	get text(): string {
		return [...this.loaded.map((entry) => entry.block), ...this.refused.map((entry) => entry.message)].join("\n\n");
	}

	get details(): SkillBatchDetails {
		return {
			skills: this.loaded.map((entry) => entry.details),
			refused: this.refused,
			loadedSkills: this.loaded.map(({ details }) => ({ name: details.name, location: details.location })),
		};
	}
}
