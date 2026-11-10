/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@octocodeai/octocode-ai";
import chalk from "chalk";
import { openImageFile, resolveUserFilePath } from "../core/image-files.ts";
import { processImage } from "../utils/image-process.ts";
import { stripBom } from "../../../common/src/text.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

interface ProcessFileOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolveUserFilePath(fileArg, process.cwd());

		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			continue;
		}

		const image = await openImageFile(absolutePath);

		if (image) {
			const processed = await processImage(await image.read(), image.mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = errorMessage(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
