import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CallToolResult, ContentBlock } from "../../client/index.ts";
import { hostImages, hostOutput } from "../../host.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type ImageLimits, sniffImageType } from "@octocodeai/octocode-ai/utils/vision";

/** The package's capture folder inside the session's working directory: the only place a result's files are read from. */
const CAPTURE_FOLDER = join(".octocode", "octocode-chrome-devtools");
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)$/i;
const MANIFEST_FILE = /manifest\.json$/i;
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 25_000_000;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_DATA_STRINGS = 20;
/** Tools whose result can hold a capture: the screenshot tool, the `check` recipes and `run` plans with a capture step. */
const CAPTURE_TOOLS: ReadonlySet<string> = new Set(["screenshot", "check", "run"]);

export const HAR_BODIES_HINT =
	"Note: this HAR/network capture has metadata only, no response bodies. To read bodies, run the `check` tool with recipe `network-body-har-fetch-check` (options BODY_URL, BODY_MATCH).";

interface CaptureFile {
	/** The file with symbolic links resolved: what is read and compared. */
	file: string;
	/** The path as the server named it, made absolute: what the model is shown. */
	shown: string;
}

/** A file under the capture folder (symbolic links followed), or undefined for anything else. */
async function captureFile(path: string, base: string, folder: string): Promise<CaptureFile | undefined> {
	try {
		const shown = resolve(base, path);
		const file = await realpath(shown);
		const inside = relative(folder, file);
		if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
		return (await stat(file)).isFile() ? { file, shown } : undefined;
	} catch {
		return undefined;
	}
}

/** Image paths and manifests a result names, as written by the server: relative to `root` (or absolute). */
function namedFiles(structured: Record<string, unknown>): {
	root: string | undefined;
	images: string[];
	manifests: string[];
} {
	const root = typeof structured.root === "string" ? structured.root : undefined;
	const images: string[] = [];
	const manifests: string[] = [];
	const name = (path: unknown) => {
		if (typeof path !== "string") return;
		if (MANIFEST_FILE.test(path)) manifests.push(path);
		else if (IMAGE_FILE.test(path)) images.push(path);
	};
	if (Array.isArray(structured.artifacts))
		for (const entry of structured.artifacts) name(isRecord(entry) ? entry.path : undefined);
	// `data` holds paths for some recipes; look a few levels in and stop after a handful of strings.
	let seen = 0;
	const walk = (value: unknown, depth: number) => {
		if (seen >= MAX_DATA_STRINGS || depth > 3) return;
		if (typeof value === "string") {
			seen++;
			name(value);
		} else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
		else if (isRecord(value)) for (const item of Object.values(value)) walk(item, depth + 1);
	};
	walk(structured.data, 0);
	return { root, images, manifests };
}

/** The tile files a capture manifest lists, in order. */
async function manifestTiles(manifest: string): Promise<string[]> {
	try {
		if ((await stat(manifest)).size > MAX_MANIFEST_BYTES) return [];
		const parsed: unknown = JSON.parse(await readFile(manifest, "utf8"));
		if (!isRecord(parsed) || !Array.isArray(parsed.tiles)) return [];
		return parsed.tiles.flatMap((tile) => (isRecord(tile) && typeof tile.file === "string" ? [tile.file] : []));
	} catch {
		return [];
	}
}

interface Preview {
	lines: string[];
	images: ContentBlock[];
}

/** The image block for a saved file, fitted by dimensions to the model's limits; the original path stays in the text. */
async function previewOf(
	file: string,
	limits: ImageLimits | undefined,
): Promise<{ block: ContentBlock; note?: string } | undefined> {
	try {
		if ((await stat(file)).size > MAX_IMAGE_BYTES) return undefined;
		const bytes = await readFile(file);
		const mimeType = sniffImageType(bytes);
		if (!mimeType) return undefined;
		if (limits) {
			const fitted = await hostImages()
				.fit(bytes, mimeType, { ...limits, maxBytes: hostOutput().imageBudget(limits) })
				.catch(() => null);
			if (fitted) {
				const note = fitted.note;
				return { block: { type: "image", data: fitted.data, mimeType: fitted.mimeType }, ...(note ? { note } : {}) };
			}
		}
		return { block: { type: "image", data: bytes.toString("base64"), mimeType } };
	} catch {
		return undefined;
	}
}

/**
 * The saved screenshots a result names. A capture manifest lists its tiles (a full-page shot has several, each as tall as
 * 16000 px); only the first becomes an image, the others are listed by path. A viewport or element shot is one tile. At
 * most `MAX_IMAGES` images are attached.
 */
async function screenshotPreview(
	structured: Record<string, unknown>,
	cwd: string,
	limits: ImageLimits | undefined,
): Promise<Preview | undefined> {
	const named = namedFiles(structured);
	if (named.images.length === 0 && named.manifests.length === 0) return undefined;
	const folder = await realpath(join(cwd, CAPTURE_FOLDER)).catch(() => undefined);
	if (!folder) return undefined;
	const root = named.root === undefined ? cwd : resolve(cwd, named.root);
	const files: Array<CaptureFile & { label: string; attach: boolean }> = [];
	const add = (found: CaptureFile, label: string, attach: boolean) => {
		if (!files.some((entry) => entry.file === found.file)) files.push({ ...found, label, attach });
	};
	for (const manifest of named.manifests) {
		const manifestFile = await captureFile(manifest, root, folder);
		if (!manifestFile) continue;
		const tiles = await manifestTiles(manifestFile.file);
		for (const [index, tile] of tiles.entries()) {
			const file = await captureFile(tile, dirname(manifestFile.file), folder);
			if (file) add(file, tiles.length > 1 ? `tile ${index + 1} of ${tiles.length}` : "screenshot", index === 0);
		}
	}
	for (const image of named.images) {
		const file = await captureFile(image, root, folder);
		if (file) add(file, "screenshot", true);
	}
	const preview: Preview = { lines: [], images: [] };
	for (const entry of files) {
		let shown = false;
		if (entry.attach && preview.images.length < MAX_IMAGES) {
			const image = await previewOf(entry.file, limits);
			if (image) {
				preview.images.push(image.block);
				if (image.note) preview.lines.push(image.note);
				shown = true;
			}
		}
		preview.lines.push(`Screenshot file (${entry.label}${shown ? ", image attached" : ""}): ${entry.shown}`);
	}
	return files.length > 0 ? preview : undefined;
}

/** True when the result lists a HAR (or other network capture) and no file of response bodies. */
function harWithoutBodies(structured: Record<string, unknown>): boolean {
	const paths = Array.isArray(structured.artifacts)
		? structured.artifacts.flatMap((entry) => (isRecord(entry) && typeof entry.path === "string" ? [entry.path] : []))
		: [];
	return paths.some((path) => /\.har$/i.test(path)) && !paths.some((path) => /bodies/i.test(path));
}

/**
 * What the model should see beyond the server's text and JSON: the saved screenshot as an image next to its full file
 * paths, and a note when a HAR holds no response bodies. Files are read only from `.octocode/octocode-chrome-devtools/`
 * under `cwd`; a path the server names anywhere else is ignored.
 */
export async function presentBrowserResult(
	tool: string,
	result: CallToolResult,
	options: { cwd: string; limits?: ImageLimits },
): Promise<CallToolResult> {
	const structured = result.structuredContent;
	if (result.isError || !isRecord(structured)) return result;
	const lines: string[] = [];
	const images: ContentBlock[] = [];
	if (CAPTURE_TOOLS.has(tool)) {
		const preview = await screenshotPreview(structured, options.cwd, options.limits);
		if (preview) {
			lines.push(...preview.lines);
			images.push(...preview.images);
		}
	}
	if (harWithoutBodies(structured)) lines.push(HAR_BODIES_HINT);
	if (lines.length === 0) return result;
	return {
		...result,
		content: [...result.content, { type: "text", text: lines.join("\n") }, ...images],
	};
}
