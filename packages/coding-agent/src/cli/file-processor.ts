/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@octocodeai/octocode-ai";
import { cliStyle } from "../utils/cli-style.ts";
import { openImageFile, resolveUserFilePath } from "../core/image-files.ts";
import { processImage } from "../utils/image-process.ts";
import { stripBom } from "@octocodeai/octocode-common/text";
import { mapConcurrent } from "@octocodeai/octocode-common/map-concurrent";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

interface ProcessFileOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
}

/** Files read at once. Reads are independent; the results are assembled in argument order. */
const FILE_READ_CONCURRENCY = 8;
/** Images processed at once, lower than reads: each one holds its bytes and may start a resize worker. */
const IMAGE_PROCESS_CONCURRENCY = 3;

/** What one argument produced. Failures are kept, not thrown, so the first one in argument order is the one reported. */
type FileOutcome =
	| { kind: "missing"; path: string }
	| { kind: "unreadable"; path: string; message: string }
	| { kind: "thrown"; error: unknown }
	| { kind: "empty" }
	| { kind: "text"; text: string; image?: ImageContent };

/** At most `limit` calls of `run` in flight; the rest wait in call order. */
function slots(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async (run) => {
		if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
		active++;
		try {
			return await run();
		} finally {
			active--;
			waiting.shift()?.();
		}
	};
}

async function processFileArgument(
	fileArg: string,
	autoResizeImages: boolean,
	imageSlot: ReturnType<typeof slots>,
): Promise<FileOutcome> {
	// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
	const absolutePath = resolveUserFilePath(fileArg, process.cwd());
	try {
		await access(absolutePath);
	} catch {
		return { kind: "missing", path: absolutePath };
	}
	try {
		const stats = await stat(absolutePath);
		if (stats.size === 0) return { kind: "empty" };

		const image = await openImageFile(absolutePath);
		if (image) {
			const processed = await imageSlot(async () =>
				processImage(await image.read(), image.mimeType, { autoResizeImages }),
			);
			if (!processed.ok) return { kind: "text", text: `<file name="${absolutePath}">${processed.message}</file>\n` };
			return {
				kind: "text",
				text: `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`,
				image: { type: "image", mimeType: processed.mimeType, data: processed.data },
			};
		}
	} catch (error) {
		return { kind: "thrown", error };
	}
	try {
		const content = stripBom(await readFile(absolutePath, "utf-8"));
		return { kind: "text", text: `<file name="${absolutePath}">\n${content}\n</file>\n` };
	} catch (error: unknown) {
		return { kind: "unreadable", path: absolutePath, message: errorMessage(error) };
	}
}

/**
 * Process @file arguments into text content and image attachments. Files are read concurrently (images with a lower
 * limit); the text and images keep argument order, and the first failing argument in that order is the one reported.
 */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const imageSlot = slots(IMAGE_PROCESS_CONCURRENCY);
	const outcomes = await mapConcurrent(fileArgs, FILE_READ_CONCURRENCY, (fileArg) =>
		processFileArgument(fileArg, autoResizeImages, imageSlot),
	);

	let text = "";
	const images: ImageContent[] = [];
	for (const outcome of outcomes) {
		switch (outcome.kind) {
			case "missing":
				console.error(cliStyle.error(`Error: File not found: ${outcome.path}`));
				process.exit(1);
				break;
			case "unreadable":
				console.error(cliStyle.error(`Error: Could not read file ${outcome.path}: ${outcome.message}`));
				process.exit(1);
				break;
			case "thrown":
				throw outcome.error;
			case "empty":
				break;
			case "text":
				text += outcome.text;
				if (outcome.image) images.push(outcome.image);
		}
	}
	return { text, images };
}
