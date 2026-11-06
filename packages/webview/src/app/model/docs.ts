import {
	DOC_KINDS,
	isRepoDocPath,
	REPO_DOC_PREFIX,
	type DocKind,
	type DocSummary,
} from "@octocodeai/octocode-contracts/docs";

export const DOC_KIND_LABELS: Record<DocKind, string> = {
	rfc: "RFCs",
	research: "Research",
	brainstorm: "Brainstorms",
	review: "Reviews",
	audit: "Audits",
	plan: "Plans",
	contract: "Contracts",
	report: "Reports",
};

export interface DocGroup {
	kind: DocKind;
	topics: { topic: string; docs: DocSummary[] }[];
}

/** Documents narrowed by kind and by a case-insensitive match on title, path or status. */
export function filterDocs(docs: readonly DocSummary[], kind: string, query: string): DocSummary[] {
	const needle = query.trim().toLowerCase();
	return docs.filter(
		(doc) =>
			(!kind || doc.kind === kind) &&
			(!needle || `${doc.title}\n${doc.path}\n${doc.status ?? ""}`.toLowerCase().includes(needle)),
	);
}

/** Kind, then topic folder; the host's newest-first order is kept inside each topic and orders the topics. */
export function groupDocs(docs: readonly DocSummary[]): DocGroup[] {
	return DOC_KINDS.flatMap((kind) => {
		const topics = new Map<string, DocSummary[]>();
		for (const doc of docs) if (doc.kind === kind) topics.set(doc.topic, [...(topics.get(doc.topic) ?? []), doc]);
		return topics.size ? [{ kind, topics: [...topics].map(([topic, list]) => ({ topic, docs: list })) }] : [];
	});
}

/** The workspace-relative path a reader knows: a repository document's carries a namespace prefix the host needs. */
export function displayDocPath(path: string): string {
	return isRepoDocPath(path) ? path.slice(REPO_DOC_PREFIX.length) : path;
}

/** Documents kept apart by where they live: `.octocode/` (authored) and the git-tracked repository files. */
export function splitDocSources(docs: readonly DocSummary[]): { octocode: DocSummary[]; repo: DocSummary[] } {
	return {
		octocode: docs.filter((doc) => !isRepoDocPath(doc.path)),
		repo: docs.filter((doc) => isRepoDocPath(doc.path)),
	};
}

const BACKLOG_REF = /\bB[0-9]+\b/g;

/** Text cut into plain pieces and the backlog ids `exists` accepts; an id the board does not hold stays text. */
export function splitBacklogRefs(text: string, exists: (ref: string) => boolean): (string | { ref: string })[] {
	const parts: (string | { ref: string })[] = [];
	let last = 0;
	for (const match of text.matchAll(BACKLOG_REF)) {
		if (!exists(match[0])) continue;
		if (match.index > last) parts.push(text.slice(last, match.index));
		parts.push({ ref: match[0] });
		last = match.index + match[0].length;
	}
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}

const DIAGRAM_LABELS: Record<string, string> = {
	flowchart: "Flowchart",
	graph: "Flowchart",
	"flowchart-elk": "Flowchart · ELK",
	sequencediagram: "Sequence",
	classdiagram: "Class diagram",
	statediagram: "State diagram",
	"statediagram-v2": "State diagram",
	erdiagram: "Entity relationship",
	gantt: "Timeline plan",
	pie: "Pie chart",
	mindmap: "Mind map",
	timeline: "Timeline",
	"xychart-beta": "Chart",
	quadrantchart: "Quadrant",
	journey: "User journey",
	gitgraph: "Git graph",
	sankey: "Sankey",
	"sankey-beta": "Sankey",
	"block-beta": "Block diagram",
	"architecture-beta": "Architecture",
	kanban: "Kanban",
	"packet-beta": "Packet",
	requirementdiagram: "Requirements",
	c4context: "C4 context",
	c4container: "C4 containers",
	c4component: "C4 components",
	c4dynamic: "C4 interactions",
	c4deployment: "C4 deployment",
};

/** A reader's name for a diagram, from its first keyword (comments and front matter skipped). */
export function diagramLabel(source: string): string {
	const body = source
		.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "")
		.replace(/^\s*%%.*$/gm, "")
		.trim();
	const word = (body.split(/\s/)[0] ?? "").toLowerCase();
	return DIAGRAM_LABELS[word] ?? (word.replace(/-beta$/, "").replace(/-/g, " ") || "Diagram");
}

/** Mermaid theme variables taken from the page's own CSS variables, so a diagram follows light and dark. */
export function mermaidTheme(read: (name: string) => string, dark: boolean): Record<string, unknown> {
	const v = (name: string) => read(name) || undefined;
	return {
		darkMode: dark,
		background: v("--surface"),
		fontSize: "15px",
		primaryColor: v("--accent-soft"),
		primaryBorderColor: v("--accent"),
		primaryTextColor: v("--text"),
		secondaryColor: v("--surface-2"),
		secondaryTextColor: v("--text"),
		tertiaryColor: v("--surface"),
		tertiaryTextColor: v("--text"),
		edgeLabelBackground: v("--surface"),
		lineColor: v("--text-2"),
		textColor: v("--text"),
		clusterBkg: v("--surface-2"),
		clusterBorder: v("--border"),
		noteBkgColor: v("--surface-2"),
		noteBorderColor: v("--border"),
		actorBkg: v("--accent-soft"),
		actorBorder: v("--accent"),
		actorTextColor: v("--text"),
		signalColor: v("--text"),
		signalTextColor: v("--text"),
	};
}
