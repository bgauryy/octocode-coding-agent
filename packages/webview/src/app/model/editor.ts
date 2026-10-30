import type { BacklogMutation } from "@octocodeai/octocode-contacts/protocol";
import type { SnapshotItem, State } from "@octocodeai/octocode-contacts/snapshot";
import { ITEM_TYPES, PRIORITIES } from "./backlog.ts";
import { choice } from "./format.ts";

export const FILE_ROLES = ["changed", "reviewed", "produced"] as const;
export const VERIFICATION_STATUSES = ["not_run", "passed", "failed", "not_applicable"] as const;
export const VERIFICATION_LABELS: Record<(typeof VERIFICATION_STATUSES)[number], string> = {
	not_run: "Not run",
	passed: "Passed",
	failed: "Failed",
	not_applicable: "Not applicable",
};

/** Every editor field as text: drafts serialize them as-is and `toMutation` parses them once on save. */
export interface EditorValues {
	title: string;
	type: string;
	state: string;
	why: string;
	goal: string;
	parentId: string;
	dependsOn: string;
	priority: string;
	tags: string;
	plan: string;
	paths: string;
	evidence: string;
	urls: string;
	note: string;
	summary: string;
	files: string;
	fileRole: string;
	verificationStatus: string;
	verificationSummary: string;
	lesson: string;
}

function externalUrls(it?: SnapshotItem): string[] {
	return (it?.links ?? []).flatMap((link) => (link.target.resource === "external" ? [link.target.url] : []));
}

export function editorDefaults(it?: SnapshotItem, correction = false): EditorValues {
	const prior = correction ? it?.completions?.at(-1) : undefined;
	return {
		title: it?.title ?? "",
		type: it?.type ?? "task",
		state: it?.state ?? "backlog",
		why: it?.why ?? "",
		goal: it?.goal ?? "",
		parentId: it?.parentId ?? "",
		dependsOn: (it?.dependsOn ?? []).map((dep) => dep.id).join(", "),
		priority: it?.priority ?? "p2",
		tags: it?.tags.join(", ") ?? "",
		plan: it?.plan ?? "",
		paths: it?.paths.join("\n") ?? "",
		evidence: it?.evidence.join("\n") ?? "",
		urls: externalUrls(it).join("\n"),
		note: "",
		summary: prior?.summary ?? "",
		files: prior?.files.map((file) => file.path).join("\n") ?? "",
		fileRole: "changed",
		verificationStatus: prior?.verification.status ?? "not_run",
		verificationSummary: prior?.verification.summary ?? "Manually completed without recorded verification.",
		lesson: prior?.lesson ?? "",
	};
}

/**
 * A tab-local draft over the editor defaults. Drafts saved before the editor used `why` and dropped the details field
 * keep their text: `reason` becomes `why`, and details the user changed join the note, so nothing typed is lost.
 */
export function restoreDraft(text: string, it?: SnapshotItem, correction = false): EditorValues {
	const { reason, body, ...saved } = JSON.parse(text) as Partial<EditorValues> & { reason?: string; body?: string };
	const values = { ...editorDefaults(it, correction), ...saved };
	if (saved.why === undefined && typeof reason === "string") values.why = reason;
	const details = typeof body === "string" ? body.trim() : "";
	if (details && details !== (it?.body ?? "").trim())
		values.note = [values.note.trim(), details].filter(Boolean).join("\n\n");
	return values;
}

/** Whether saving these values records a completion, and so shows the completion fields. */
export function needsCompletion(values: Pick<EditorValues, "state">, it?: SnapshotItem, correction = false): boolean {
	return values.state === "done" && (correction || !it || it.state !== "done");
}
/** Goal and why are frozen once an item is done; reopen it to change them. */
export function locksIntent(values: Pick<EditorValues, "state">, it?: SnapshotItem): boolean {
	return values.state === "done" && it?.state === "done";
}

const words = (text: string) => text.split(/[\s,]+/).filter(Boolean);
const lines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

interface MutationContext {
	item?: SnapshotItem;
	correction?: boolean;
	baseVersion?: number;
	operationKey: string;
	states: readonly State[];
}

export function toMutation(raw: EditorValues, context: MutationContext): BacklogMutation {
	const { item: it, correction = false } = context;
	const values = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.trim()])) as EditorValues;
	const prior = it?.completions?.at(-1);
	const mutation: BacklogMutation = {
		op: it ? "update" : "add",
		title: values.title,
		type: choice(values.type, ITEM_TYPES),
		state: choice(values.state, context.states),
		goal: values.goal,
		why: values.why,
		parentId: values.parentId || null,
		dependsOn: words(values.dependsOn),
		priority: PRIORITIES.indexOf(choice(values.priority, PRIORITIES)),
		tags: words(values.tags),
		plan: values.plan,
		paths: lines(values.paths),
		evidence: lines(values.evidence),
		links: [
			...(it?.links ?? []).filter((link) => link.target.resource !== "external"),
			...lines(values.urls).map(
				(url) =>
					it?.links?.find((link) => link.target.resource === "external" && link.target.url === url) ?? {
						relation: "related" as const,
						target: { resource: "external" as const, url },
					},
			),
		],
	};
	if (it) {
		mutation.id = it.ref;
		mutation.version = context.baseVersion;
	}
	if (locksIntent(values, it)) {
		delete mutation.goal;
		delete mutation.why;
	}
	if (values.note) mutation.note = values.note;
	if (needsCompletion(values, it, correction)) {
		mutation.completion = {
			summary: values.summary,
			files: lines(values.files).map(
				(path) =>
					(correction ? prior?.files.find((file) => file.path === path) : undefined) ?? {
						path,
						role: choice(values.fileRole, FILE_ROLES),
					},
			),
			verification: {
				status: choice(values.verificationStatus, VERIFICATION_STATUSES),
				summary: values.verificationSummary,
			},
			operationKey: context.operationKey,
			...(correction && prior ? { replaces: prior.id } : {}),
			...(values.lesson ? { lesson: values.lesson } : {}),
		};
	}
	return mutation;
}
