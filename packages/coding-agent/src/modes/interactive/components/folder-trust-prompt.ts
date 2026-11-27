import { basename } from "node:path";
import { shown } from "../../../octocode/trust/messages.ts";
import { TrustPromptComponent, type TrustPromptRow } from "./trust-prompt.ts";

/** What the user chose. `refuse` is recorded ("Do not trust"); `not-now` records nothing. */
export type TrustChoice = "folder" | "parent" | "grandparent" | "refuse" | "not-now";

export interface TrustPromptInput {
	/** The real path of the folder being opened. */
	path: string;
	/** Omitted when it is a refused root (the home folder or a filesystem root). */
	parent?: string;
	/** Omitted when it is a refused root; never offered without a parent. */
	grandparent?: string;
	/** Names only of the project files found (a directory listing, nothing read). */
	projectFiles: string[];
}

const MAX_LISTED = 8;

/** The folder's own name (`app` for `/work/app`), for a row label. */
const name = (folder: string): string => basename(folder) || folder;

/** `Found here: AGENTS.md, .mcp.json` (names, never contents), or the reassurance that there is nothing. */
function found(files: string[]): string {
	if (files.length === 0) return "This folder has no project files yet.";
	const listed = files.slice(0, MAX_LISTED).join(", ");
	return `Found here: ${listed}${files.length > MAX_LISTED ? `, and ${files.length - MAX_LISTED} more` : ""}`;
}

/**
 * The trust question for a folder nobody has decided on, shown before any session, model call or project file read.
 * One screen: the folder, what trust allows, the project file names found, and the answers. `Not now` comes first and
 * starts selected, so a bare Enter grants nothing; the narrowest grant (this folder) is the recommended one, and wider
 * grants name the folder they would cover.
 */
export function folderTrustPrompt(
	input: TrustPromptInput,
	done: (choice: TrustChoice) => void,
	home?: string,
	armDelayMs?: number,
): TrustPromptComponent<TrustChoice> {
	const rows: TrustPromptRow<TrustChoice>[] = [
		{ label: "Not now", note: "exit; ask again next time", value: "not-now" },
		{ label: "Trust this folder", note: "(recommended)", value: "folder" },
	];
	if (input.parent !== undefined) {
		rows.push({
			label: `Trust parent ${name(input.parent)}`,
			note: `everything under ${shown(input.parent, home)}`,
			value: "parent",
		});
		if (input.grandparent !== undefined)
			rows.push({
				label: `Trust grandparent ${name(input.grandparent)}`,
				note: `everything under ${shown(input.grandparent, home)}`,
				value: "grandparent",
			});
	}
	rows.push({ label: "Do not trust", note: "exit; remember this choice", value: "refuse" });
	return new TrustPromptComponent<TrustChoice>({
		title: "Do you trust this folder?",
		subject: input.path,
		body: [
			"Octocode can read and change files here, run commands, and load this folder's instructions, settings, hooks, MCP servers, skills and plugins. Only trust folders whose contents you trust.",
			"Nothing here has been read or run yet.",
		],
		detail: found(input.projectFiles),
		...(input.parent === undefined
			? { footnote: "Folders above this one (your home folder or the filesystem root) cannot be trusted." }
			: {}),
		rows,
		onChoose: done,
		onCancel: () => done("not-now"),
		...(armDelayMs === undefined ? {} : { armDelayMs }),
	});
}

/**
 * "Trust new worktree <path> (from <repo>)?": asked once, when Octocode creates a worktree. When the repository it is
 * made from is not trusted either, the question says so and no answer is recommended. `No` comes first and starts
 * selected.
 */
export function worktreeTrustPrompt(
	input: { path: string; from: string; originTrusted?: boolean },
	done: (trust: boolean) => void,
	home?: string,
	armDelayMs?: number,
): TrustPromptComponent<boolean> {
	const originUntrusted = input.originTrusted === false;
	return new TrustPromptComponent<boolean>({
		title: `Trust new worktree ${shown(input.path, home)} (from ${shown(input.from, home)})?`,
		body: [
			"A worktree is a separate folder, so it needs its own trust. Trusting it lets Octocode read and change files there, run commands, and load its project instructions, settings, hooks, MCP servers, skills and plugins.",
			...(originUntrusted
				? [
						`${shown(input.from, home)} is not trusted either. The worktree holds that repository's committed files, so trusting it trusts that content, including its hooks and MCP servers.`,
					]
				: []),
		],
		rows: [
			{ label: "No", note: "do not create the worktree", value: false },
			{ label: "Trust this worktree", ...(originUntrusted ? {} : { note: "(recommended)" }), value: true },
		],
		onChoose: done,
		onCancel: () => done(false),
		...(armDelayMs === undefined ? {} : { armDelayMs }),
	});
}
