/**
 * Pasted image paths. A terminal drop arrives as bracketed-paste text: a path, quoted, with backslash-escaped spaces
 * or as a file:// URL, several separated by spaces. When every token is an existing image file, the paste becomes
 * those absolute paths (one shell-quoted token each); the prompt attaches them as images at submit, like a Ctrl+V image.
 */

import { statSync } from "node:fs";
import { extname } from "node:path";
import { resolveCandidate, splitPathWords } from "../../../core/agent-session/prompt-image-paths.ts";
import { quoteIfNeeded } from "./helpers.ts";
import type { InteractiveModeHost } from "./host.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** A pasted path is short; anything longer is prose or a log. */
const MAX_PASTE_LENGTH = 4096;

function existingImage(word: string, cwd: string): string | undefined {
	let path: string | undefined;
	try {
		path = resolveCandidate(word, cwd);
	} catch {
		return undefined;
	}
	if (!path || !IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return undefined;
	try {
		return statSync(path).isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}

/** The existing image files a paste names, or undefined when any part of it is not one. */
function pastedImagePaths(text: string, cwd: string): string[] | undefined {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > MAX_PASTE_LENGTH || /\p{Cc}/u.test(trimmed.replace(/\s/g, ""))) return undefined;
	// An unquoted path with raw spaces is one file; otherwise the words are separate paths.
	const whole = existingImage(trimmed, cwd);
	if (whole) return [whole];
	const words = splitPathWords(trimmed);
	if (!words || words.length === 0) return undefined;
	const paths: string[] = [];
	for (const word of words) {
		const path = existingImage(word, cwd);
		if (!path) return undefined;
		paths.push(path);
	}
	return paths;
}

type PasteHost = Pick<InteractiveModeHost, "session" | "showWarning" | "showStatus">;

/**
 * The text to insert for a paste, or undefined to leave the paste as it is. With a model that takes no images the
 * paste stays text and one hint says why.
 */
export function rewritePastedImagePaths(host: PasteHost, text: string): string | undefined {
	const paths = pastedImagePaths(text, host.session.sessionManager.getCwd());
	if (!paths) return undefined;
	if (!host.session.model?.input.includes("image")) {
		host.showWarning("This model cannot take images: the pasted path stays text.");
		return undefined;
	}
	host.showStatus(`${paths.length === 1 ? "1 image attaches" : `${paths.length} images attach`} when you send.`);
	return paths.map(quoteIfNeeded).join(" ");
}
