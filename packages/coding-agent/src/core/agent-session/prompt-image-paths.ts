/**
 * Image files named in a user-typed prompt (terminal and /web input), attached as image content at submit. The text
 * is sent unchanged; a file that cannot be attached adds a hint after it instead of failing the prompt.
 */

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ImageContent, Model } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openImageFile, resolveUserFilePath } from "../image-files.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { normalizePromptImages } from "./prompt-expansion.ts";

/** Most images one prompt attaches from paths; a lower per-message limit of the model wins. */
const MAX_PATH_IMAGES = 8;
/** Larger files are not read. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Most path spellings checked per prompt, so a long pasted log costs a bounded number of file lookups. */
const MAX_CANDIDATES = 100;

const PATH_START = /^(?:\/|~\/|\.\.?\/|file:\/\/)/;
/** A quoted span whose opening quote does not follow a letter or digit, so apostrophes in prose do not open one. */
const QUOTED = /(?<![\p{L}\p{N}])(["'])((?:(?!\1)[^\n])+)\1/gu;
/** A whitespace-separated token; a backslash escapes the next character (drag-and-drop escapes spaces). */
const TOKEN = /(?:\\.|[^\s\\])+/g;
const LEADING_PUNCTUATION = /^[(<[{"'`]+/;
const TRAILING_PUNCTUATION = /[)>\]}"'`.,;:!?]+$/;

/** Shell-style words: whitespace separates, quotes group, a backslash escapes the next character; undefined when a quote is left open. */
export function splitPathWords(text: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			else if (ch === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && i + 1 < text.length) {
			word += text[++i];
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += ch;
			inWord = true;
		}
	}
	if (quote) return undefined;
	if (inWord) words.push(word);
	return words;
}

/**
 * Path-like spellings in the text in order of appearance: quoted spans, whole lines (a pasted file path may contain
 * unescaped spaces) and tokens with backslash escapes undone, each token also without surrounding punctuation.
 */
function imagePathCandidates(text: string): string[] {
	const found: { index: number; candidate: string }[] = [];
	const add = (index: number, candidate: string) => {
		const trimmed = candidate.trim();
		if (PATH_START.test(trimmed)) found.push({ index, candidate: trimmed });
	};
	for (const match of text.matchAll(QUOTED)) add(match.index, match[2]);
	let offset = 0;
	for (const line of text.split("\n")) {
		add(offset, line);
		offset += line.length + 1;
	}
	for (const match of text.matchAll(TOKEN)) {
		const token = match[0].replace(/\\(.)/g, "$1");
		add(match.index, token);
		add(match.index, token.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, ""));
	}
	for (const word of splitPathWords(text) ?? []) add(text.indexOf(word), word);
	found.sort((a, b) => a.index - b.index);
	return [...new Set(found.map((entry) => entry.candidate))].slice(0, MAX_CANDIDATES);
}

export function resolveCandidate(candidate: string, cwd: string): string | undefined {
	if (!candidate.startsWith("file://")) return resolveUserFilePath(candidate, cwd);
	try {
		return fileURLToPath(candidate);
	} catch {
		return undefined;
	}
}

/** The images the text names, each real file once, and hints for files that could not be attached. */
async function findPathImages(
	text: string,
	cwd: string,
	model: Model<any>,
	existing: number,
): Promise<{ images: ImageContent[]; hints: string[] }> {
	const limit = Math.min(MAX_PATH_IMAGES, model.inputLimits?.images?.maxPerMessage ?? MAX_PATH_IMAGES);
	const images: ImageContent[] = [];
	const hints: string[] = [];
	const seen = new Set<string>();
	let over = 0;
	for (const candidate of imagePathCandidates(text)) {
		const path = resolveCandidate(candidate, cwd);
		if (!path) continue;
		let real: string;
		try {
			real = await realpath(path);
		} catch {
			continue; // Not an existing file: the path stays plain text.
		}
		if (seen.has(real)) continue;
		seen.add(real);
		try {
			const file = await openImageFile(real);
			if (!file) continue;
			if (existing + images.length >= limit) over++;
			else if (file.size > MAX_IMAGE_BYTES) hints.push(`[Image not attached: ${path} is over 20 MB.]`);
			else images.push({ type: "image", mimeType: file.mimeType, data: (await file.read()).toString("base64") });
		} catch (error) {
			hints.push(`[Image not attached: ${path}: ${errorMessage(error)}]`);
		}
	}
	if (over > 0) {
		hints.push(
			`[${over} more image ${over === 1 ? "path" : "paths"} not attached: at most ${limit} images per message.]`,
		);
	}
	return { images, hints };
}

export interface PathImagesHost {
	readonly cwd: string;
	readonly session: { readonly model: Model<any> | undefined; readonly settingsManager: SettingsManager };
	limitsModel(): Model<any> | undefined;
}

/**
 * Add the images a user-typed prompt names after any images it already carries, and append hints for files that
 * could not be attached. A model without image input gets the prompt as text. Queued input is resized here; a
 * starting run resizes its prompt images itself.
 */
export async function attachPromptPathImages(
	host: PathImagesHost,
	text: string,
	images: ImageContent[] | undefined,
	queued: boolean,
): Promise<{ text: string; images: ImageContent[] | undefined }> {
	const model = host.session.model;
	if (!model?.input.includes("image")) return { text, images };
	const found = await findPathImages(text, host.cwd, model, images?.length ?? 0);
	let added = found.images;
	const hints = found.hints;
	if (queued && added.length > 0) {
		const normalized = await normalizePromptImages(host.session.settingsManager, host.limitsModel(), added);
		added = normalized.images;
		hints.push(...normalized.hints);
	}
	return {
		text: hints.length > 0 ? `${text}\n\n${hints.join("\n")}` : text,
		images: added.length > 0 ? [...(images ?? []), ...added] : images,
	};
}
