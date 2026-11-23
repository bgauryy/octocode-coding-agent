import fs from "node:fs/promises";
import { atomicWriteFileUnlocked } from "@octocodeai/octocode-common/atomic-file";
import path from "node:path";
import { sessionFolder } from "../shared/home.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";

/**
 * A subagent's screenshots (the browser MCP tools) live only in its own conversation. The parent saves the
 * latest ones next to the team database so the user sees what the agent sees, live in the tool row and as a path to open.
 */

/** Largest screenshot (base64 chars) drawn inline in the tool row; bigger ones are only saved. */
export const INLINE_MAX_CHARS = 256 * 1024;
const KEEP_FILES = 30;
// Live previews are best effort. A single large original still gets a turn even when it exceeds the waiting budget.
const QUEUED_SHOT_CHARS = 2 * 1024 * 1024;
const PRUNE_EVERY = 8;

export interface Shot {
	path: string;
	/** Base64 data when small enough to draw inline. */
	data?: string;
	mimeType: string;
}

/** Image parts of a tool result (`result.content[]` with type "image"). */
export function imagesOf(result: unknown): Array<{ data: string; mimeType: string }> {
	const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
	return content.flatMap((part) =>
		isRecord(part) && part.type === "image" && typeof part.data === "string"
			? [{ data: part.data, mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png" }]
			: [],
	);
}

export function shotsDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(sessionFolder("output", undefined, env), "shots");
}

type ImagePart = { data: string; mimeType: string };

/** Publish the path only after the atomic rename. Each run writes its numbered screenshots in order. */
export async function saveShot(dir: string, agentId: string, index: number, image: ImagePart): Promise<Shot> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(dir);
	if (!stat.isDirectory()) throw new Error("Screenshot storage requires a real directory");
	// A shared folder owned by another user keeps its mode, like privateDir. New files are always owner-only.
	if ((stat.mode & 0o777) !== 0o700 && (!process.getuid || stat.uid === process.getuid())) await fs.chmod(dir, 0o700);
	const extension = image.mimeType.includes("jpeg") ? "jpg" : "png";
	const file = path.join(dir, `${agentId}-${index}.${extension}`);
	await atomicWriteFileUnlocked(file, Buffer.from(image.data, "base64"), { mode: PRIVATE_FILE_MODE });
	return {
		path: file,
		mimeType: image.mimeType,
		...(image.data.length <= INLINE_MAX_CHARS ? { data: image.data } : {}),
	};
}

async function pruneShots(dir: string): Promise<void> {
	const names = (await fs.readdir(dir)).filter((name) => /-\d+\.(?:png|jpg)$/.test(name));
	if (names.length <= KEEP_FILES) return;
	const files = await Promise.all(
		names.map(async (name) => {
			const file = path.join(dir, name);
			try {
				return { file, mtime: (await fs.lstat(file)).mtimeMs };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return { file, mtime: -Infinity };
			}
		}),
	);
	files.sort((a, b) => b.mtime - a.mtime);
	await Promise.all(files.slice(KEEP_FILES).map(({ file }) => fs.rm(file, { force: true })));
}

/** One writer per child. Under disk pressure coalesce older queued previews. The tool results stay in the child session. */
export class ShotWriter {
	private readonly queue: Array<{ index: number; image: ImagePart; saved: (shot: Shot) => void }> = [];
	private index = 0;
	private pending?: Promise<void>;
	private unpruned = 0;
	private queuedChars = 0;

	private readonly dir: string;
	private readonly agentId: string;

	constructor(dir: string, agentId: string) {
		this.dir = dir;
		this.agentId = agentId;
	}

	add(image: ImagePart, saved: (shot: Shot) => void): void {
		while (
			this.queue.length &&
			(this.queue.length >= KEEP_FILES || this.queuedChars + image.data.length > QUEUED_SHOT_CHARS)
		) {
			this.queuedChars -= this.queue.shift()!.image.data.length;
		}
		this.queuedChars += image.data.length;
		this.queue.push({ index: ++this.index, image, saved });
		this.pending ??= this.write();
	}

	private async write(): Promise<void> {
		try {
			while (this.queue.length) {
				const { index, image, saved } = this.queue.shift()!;
				this.queuedChars -= image.data.length;
				try {
					const shot = await saveShot(this.dir, this.agentId, index, image);
					this.unpruned++;
					saved(shot);
					if (this.unpruned >= PRUNE_EVERY) await this.prune();
				} catch (error) {
					this.warn(error);
				}
			}
		} finally {
			this.pending = undefined;
		}
	}

	private async prune(): Promise<void> {
		await pruneShots(this.dir);
		this.unpruned = 0;
	}

	private warn(error: unknown): void {
		process.stderr.write(`Subagent screenshot: ${String(error)}\n`);
	}

	async finish(): Promise<void> {
		await this.pending;
		if (this.unpruned) await this.prune().catch((error) => this.warn(error));
	}
}
