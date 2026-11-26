import type { WorkLink } from "@octocodeai/octocode-contracts/backlogs";

/**
 * Evidence that is only a reference (an http(s) URL, or a repository path such as `src/a.ts`, `docs/` or
 * `.octocode/x/report.md`) is a typed `evidence` link rather than text: item writes convert it, and the version-11 upgrade
 * converted the rows stored before that. Anything else stays text: `path:line — what it shows`, a command, a root file
 * name such as `README.md` (too easily a word like `node.js`), or a path that leaves the repository.
 */
function evidenceLink(entry: string, repositoryKey: string): WorkLink | undefined {
	const text = entry.trim();
	if (/^https?:\/\/\S+$/i.test(text)) {
		try {
			const url = new URL(text);
			return url.username || url.password
				? undefined
				: { relation: "evidence", target: { resource: "external", url: text } };
		} catch {
			return undefined;
		}
	}
	const path = text.replace(/^\.\//, "");
	if (!/^[\w@.+-]+(?:\/[\w@.+-]+)*\/?$/.test(path)) return undefined;
	const segments = path.split("/").filter(Boolean);
	if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
	const name = segments.at(-1)!;
	const nested = segments.length > 1 || path.endsWith("/") || name.startsWith(".");
	const file = /[^.]\.[A-Za-z0-9]{1,10}$/.test(name);
	if (!nested || !(file || path.endsWith("/"))) return undefined;
	return { relation: "evidence", target: { resource: "files", repositoryKey, path } };
}

/** Evidence split into the text that stays evidence and the entries that are links, each in its given order. */
export function splitEvidence(
	entries: readonly string[],
	repositoryKey: string,
): { text: string[]; links: WorkLink[] } {
	const text: string[] = [];
	const links: WorkLink[] = [];
	for (const entry of entries) {
		const link = evidenceLink(entry, repositoryKey);
		if (link) links.push(link);
		else text.push(entry);
	}
	return { text, links };
}
