import fs from "node:fs";
import path from "node:path";
import { sha256Hasher } from "@octocodeai/octocode-common/atomic-file";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** A host-recorded report version. Without a path, use the current answer received in the transcript. */
export interface ReportArtifact {
	sha256: string;
	path?: string;
}

const DIGEST = /^[a-f0-9]{64}$/;
const VERSION_FILE = /^report-([a-f0-9]{64})\.md$/;
const READ_BYTES = 16 * 1024;

export function reportArtifact(value: unknown): ReportArtifact | undefined {
	if (!isRecord(value) || typeof value.sha256 !== "string" || !DIGEST.test(value.sha256)) return undefined;
	if (value.path !== undefined && typeof value.path !== "string") return undefined;
	return { sha256: value.sha256, ...(typeof value.path === "string" ? { path: value.path } : {}) };
}

function reportDigest(file: string): string {
	if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error("its scratch folder is a link");
	const hash = sha256Hasher();
	const buffer = Buffer.alloc(64 * 1024);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || !regularReportFile(file)) throw new Error("not a regular report");
		let bytes: number;
		while ((bytes = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes));
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest("hex");
}

/**
 * Opens a file in a child's scratch folder for writing without following a link the child planted there. A missing
 * file is created exclusively (`O_EXCL`, which also refuses a dangling link); an existing one must be a plain file with
 * one name, checked on the open descriptor before anything is cut, and it is emptied unless `append`. The scratch
 * folder itself must not be a link. Throws when the path is not safe to write; the caller decides what to keep.
 */
export function openScratchFile(file: string, options: { append?: boolean } = {}): number {
	if (fs.lstatSync(path.dirname(file)).isSymbolicLink()) throw new Error("its scratch folder is a link");
	const base = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0) | (options.append ? fs.constants.O_APPEND : 0);
	let created = false;
	let fd: number;
	try {
		fd = fs.openSync(file, base | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE);
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		fd = fs.openSync(file, base);
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1) throw new Error("not a regular file with one name");
		if (!created && !options.append) fs.ftruncateSync(fd, 0);
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

/** Writes `data` as the whole content of a scratch file; see `openScratchFile`. */
export function writeScratchFile(file: string, data: string): void {
	const fd = openScratchFile(file);
	try {
		fs.writeFileSync(fd, data);
	} finally {
		fs.closeSync(fd);
	}
}

/** Appends to a scratch file, first cutting it to `keep` bytes when given; see `openScratchFile`. */
export function appendScratchFile(file: string, data: string, keep?: number): void {
	const fd = openScratchFile(file, { append: true });
	try {
		if (keep !== undefined) fs.ftruncateSync(fd, keep);
		fs.writeFileSync(fd, data);
	} finally {
		fs.closeSync(fd);
	}
}

/** Keep old versions when the compatibility report.md is replaced by a continuation. */
export function snapshotReport(file: string): ReportArtifact {
	const sha256 = reportDigest(file);
	const target = path.join(path.dirname(file), `report-${sha256}.md`);
	try {
		fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (reportDigest(target) !== sha256) throw new Error("report snapshot changed while it was saved");
	return { path: target, sha256 };
}

/** A plain file with one name, never a link to a file kept elsewhere. */
export function regularReportFile(file: string): boolean {
	try {
		const stat = fs.lstatSync(file);
		return stat.isFile() && stat.nlink === 1;
	} catch {
		return false;
	}
}

/** Validate the entire version with bounded memory, retaining only a small UTF-8 preview. */
export async function readChildReport(
	report: string,
	expectedSha?: string,
): Promise<{
	text: string;
	at: number;
	sha256: string;
	truncated: boolean;
	tail: string;
}> {
	const scratch = path.dirname(report);
	const name = path.basename(report);
	const version = VERSION_FILE.exec(name)?.[1];
	if (name !== "report.md" && (!version || version !== expectedSha)) throw new Error("not a report file");
	if ((await fs.promises.lstat(scratch)).isSymbolicLink()) throw new Error("its scratch folder is a link");
	const handle = await fs.promises.open(report, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.nlink !== 1 || !regularReportFile(report)) throw new Error("not a regular file");
		const [real, root] = await Promise.all([fs.promises.realpath(report), fs.promises.realpath(scratch)]);
		if (real !== path.join(root, name)) throw new Error("outside the child's scratch folder");
		const hash = sha256Hasher();
		const buffer = Buffer.alloc(64 * 1024);
		const parts: Buffer[] = [];
		let tail = Buffer.alloc(0);
		let total = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer);
			if (!bytesRead) break;
			hash.update(buffer.subarray(0, bytesRead));
			tail = Buffer.concat([tail, buffer.subarray(0, bytesRead)]).subarray(-2048);
			if (total < READ_BYTES) parts.push(Buffer.from(buffer.subarray(0, Math.min(bytesRead, READ_BYTES - total))));
			total += bytesRead;
		}
		const sha256 = hash.digest("hex");
		if (expectedSha && sha256 !== expectedSha) throw new Error("report content no longer matches its recorded sha256");
		const text = new TextDecoder().decode(Buffer.concat(parts), { stream: total > READ_BYTES });
		return { text, at: stat.mtimeMs, sha256, truncated: total > READ_BYTES, tail: tail.toString("utf8") };
	} finally {
		await handle.close();
	}
}
