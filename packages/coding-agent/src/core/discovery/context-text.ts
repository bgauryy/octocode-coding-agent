import { type ContextView, PI_CODE_HINT, activeEntries, problemSummary } from "./context-view.ts";
import { homeTilde } from "@octocodeai/octocode-common/home-tilde";

/** `…/deep/folder/SKILL.md`: the end of a path, cut from the left to fit `room` cells. */
function fitPath(path: string, room: number): string {
	if (path.length <= room || room < 8) return path;
	const tail = path.slice(path.length - (room - 1));
	// Start at a folder boundary when one is near, so no name is cut mid-word.
	const slash = tail.indexOf("/");
	return `\u2026${slash >= 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`;
}

/**
 * The loaded-context view as plain text, for `/harness config` in modes with no terminal screen. One block per kind with its
 * count; per item a line with its source, name and why it is not loaded when it is not, and below it the path on its own
 * indented line, cut from the left with `\u2026` when `width` is given and it does not fit. Entries carry file names and
 * server text, so the caller sanitizes the whole text before showing it.
 */
export function formatContextText(view: ContextView, home: string, width?: number): string {
	const indent = "    ";
	const blocks = view.groups.map((group) => {
		const problems = problemSummary(group);
		const lines = group.entries.flatMap((entry) => {
			const note = entry.note ? ` (${entry.note})` : "";
			const path = homeTilde(entry.path, home);
			return [
				`  ${entry.source}: ${entry.name}${note}`,
				`${indent}${width ? fitPath(path, width - indent.length) : path}`,
			];
		});
		const hint = group.id === "extension" ? [`  ${PI_CODE_HINT}`] : [];
		return [
			`${group.title} (${activeEntries(group).length})${problems ? ` \u2014 ${problems}` : ""}`,
			...lines,
			...hint,
		].join("\n");
	});
	if (blocks.length === 0) return "Nothing is loaded from configuration folders.";
	const warnings = view.warnings.map((warning) =>
		[`! ${warning.text}`, ...warning.details.map((detail) => `    ${detail}`)].join("\n"),
	);
	return [
		"Loaded context and where each item came from",
		...blocks,
		...(warnings.length ? ["Warnings", ...warnings] : []),
	].join("\n\n");
}
