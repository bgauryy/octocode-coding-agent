/**
 * Image files the user names: path resolution and magic-byte detection shared by `@file` arguments and image paths
 * in typed prompts.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { detectSupportedImageMimeTypeFromFile } from "@octocodeai/octocode-ai/utils/mime";
import { resolveReadPath } from "./tools/path-utils.ts";

/** Absolute path for a path the user typed: `~`, cwd-relative, a leading `@`, and macOS screenshot name variants. */
export function resolveUserFilePath(input: string, cwd: string): string {
	return resolve(resolveReadPath(input, cwd));
}

/** A regular file whose leading bytes are a supported image; `read` loads its bytes. */
export interface ImageFile {
	mimeType: string;
	size: number;
	read(): Promise<Buffer>;
}

/** The file as an image, or undefined when it is not a regular file or not a supported image. Throws on read errors. */
export async function openImageFile(path: string): Promise<ImageFile | undefined> {
	const stats = await stat(path);
	if (!stats.isFile() || stats.size === 0) return undefined;
	const mimeType = await detectSupportedImageMimeTypeFromFile(path);
	if (!mimeType) return undefined;
	return { mimeType, size: stats.size, read: () => readFile(path) };
}
