import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Value } from "typebox/value";
import {
	REPORT_SOURCE_DIRS,
	WORKSPACE_ROUTES,
	ReportFileSchema,
	ReportsIndexSchema,
	type ReportFile,
	type ReportFileSummary,
	type ReportSummary,
	type ReportsIndex,
} from "@octocodeai/octocode-contracts/protocol";
import { workspaceOctocodeDir } from "../shared/home.ts";
import { redactData } from "../../../../common/src/sanitize.ts";
import { cutText } from "../../../../common/src/text.ts";

/** Folders the report renderer itself treats as scratch or build output, so the board does not list them. */
const SKIPPED_FOLDERS = new Set(["tmp", "view", "node_modules"]);
/** A single report file stays small enough to fit one frame; larger files are skipped, not truncated mid-sentence. */
const MAX_REPORT_FILE_BYTES = 512 * 1024;
const MAX_REPORTS = 200;

function isReportFolder(name: string): boolean {
	return !name.startsWith(".") && !SKIPPED_FOLDERS.has(name);
}

/** A report field cut to `max` characters with no marker (a cut value stays a plain status, confidence or question). */
export function truncate(value: string | undefined, max: number): string | undefined {
	return value === undefined ? undefined : cutText(value, max, { chars: true });
}

/** Returns true when the entry at `filePath` is a symbolic link. Symlinks are never followed for report content. */
export function isSymlink(filePath: string): boolean {
	try {
		return fs.lstatSync(filePath).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Flat frontmatter keys the saved skills write (`status`, `question`, `confidence`); multi-line values are not parsed. */
export function readFrontmatter(markdown: string): Record<string, string> {
	const text = markdown.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return {};
	const end = text.indexOf("\n---", 4);
	if (end < 0) return {};
	const out: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const match = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
		if (!match) continue;
		const value = match[2].trim().replace(/^["']|["']$/g, "");
		if (value) out[match[1]] = value;
	}
	return out;
}

export function firstHeading(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	let inFrontmatter = false;
	let inCode = false;
	let codeFence: string | undefined;
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (inFrontmatter) {
			if (trimmed === "---") inFrontmatter = false;
			continue;
		}
		if (index === 0 && trimmed === "---") {
			inFrontmatter = true;
			continue;
		}
		if (inCode) {
			if (trimmed.startsWith(codeFence!)) inCode = false;
			continue;
		}
		const fenceMatch = /^(```|~~~)/.exec(trimmed);
		if (fenceMatch) {
			inCode = true;
			codeFence = fenceMatch[1];
			continue;
		}
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
	return "";
}

function listReportFiles(folder: string): ReportFileSummary[] {
	const files: ReportFileSummary[] = [];
	for (const name of fs.readdirSync(folder).sort()) {
		if (!name.endsWith(".md")) continue;
		const filePath = path.join(folder, name);
		if (isSymlink(filePath)) continue;
		const stat = fs.statSync(filePath);
		if (stat.isFile() && stat.size <= MAX_REPORT_FILE_BYTES) files.push({ name, bytes: stat.size });
	}
	return files;
}

interface ScannedReport {
	summary: ReportSummary;
	folder: string;
}

function clampFiles(files: ReportFileSummary[]): ReportFileSummary[] {
	return files.filter((file) => file.name.length <= 128).slice(0, 32);
}

function sanitizeSummary(summary: ReportSummary): ReportSummary {
	if (summary.id.length > 128) throw new Error("Report id exceeds the contracts schema");
	const sanitized: ReportSummary = {
		...summary,
		title: summary.title.slice(0, 300),
		status: truncate(summary.status, 40),
		confidence: truncate(summary.confidence, 20),
		question: truncate(summary.question, 2000),
		updated: summary.updated.slice(0, 64),
		files: clampFiles(summary.files),
	};
	if (!Value.Check(ReportsIndexSchema, { reports: [sanitized] })) {
		throw new Error("Sanitized report summary still violates the contracts schema");
	}
	return sanitized;
}

function scanReports(root: string): ScannedReport[] {
	const reports: ScannedReport[] = [];
	for (const [sourceDir, kind] of Object.entries(REPORT_SOURCE_DIRS)) {
		const source = path.join(workspaceOctocodeDir(root), sourceDir);
		// A linked source folder could point anywhere on the host; like the docs library, links below `.octocode/` are never followed.
		if (isSymlink(source)) continue;
		let folders: fs.Dirent[];
		try {
			folders = fs.readdirSync(source, { withFileTypes: true });
		} catch {
			continue; // No reports of this kind in this workspace yet.
		}
		for (const entry of folders) {
			if (!entry.isDirectory() || !isReportFolder(entry.name)) continue;
			const folder = path.join(source, entry.name);
			try {
				const files = listReportFiles(folder);
				if (!files.length) continue;
				const primary = files.find((file) => file.name === "RFC.md") ?? files[0];
				const primaryPath = path.join(folder, primary.name);
				if (isSymlink(primaryPath)) continue;
				const primaryText = fs.readFileSync(primaryPath, "utf8");
				const stamps = files.map((file) => fs.statSync(path.join(folder, file.name)).mtime.toISOString()).sort();
				const frontmatter = readFrontmatter(primaryText);
				const summary: ReportSummary = {
					id: entry.name,
					kind,
					title: firstHeading(primaryText) || entry.name,
					status: frontmatter.status,
					confidence: frontmatter.confidence,
					question: frontmatter.question,
					updated: stamps[stamps.length - 1],
					files,
				};
				reports.push({ folder, summary: sanitizeSummary(summary) });
			} catch {
				continue; // A half-readable folder is skipped whole rather than half-listed.
			}
		}
	}
	return reports.sort((a, b) => (a.summary.updated < b.summary.updated ? 1 : -1)).slice(0, MAX_REPORTS);
}

type Reply = (status: number, body: unknown) => void;

/**
 * The reports' read-only routes, called only after the loopback host, origin and bearer capability have been checked.
 * Returns true when the request was answered.
 */
export function handleReportsRequest(req: IncomingMessage, url: URL, repoRoot: string, reply: Reply): boolean {
	if (url.pathname !== WORKSPACE_ROUTES.reports && url.pathname !== `${WORKSPACE_ROUTES.reports}/file`) return false;
	if (req.method !== "GET") {
		reply(405, { error: "Reports are read-only." });
		return true;
	}
	if (url.pathname === WORKSPACE_ROUTES.reports) {
		reply(200, redactData(readReportsIndex(repoRoot)));
		return true;
	}
	const id = url.searchParams.get("id") ?? "";
	const kind = url.searchParams.get("kind") ?? "";
	const name = url.searchParams.get("name") ?? "";
	const report = id && kind && name ? readReportFile(repoRoot, id, kind, name) : undefined;
	reply(report ? 200 : 404, report ? redactData(report) : { error: "Report not found in this workspace" });
	return true;
}

/** The report index the workspace board serves: newest first, bounded, without folder paths. */
export function readReportsIndex(root: string): ReportsIndex {
	const index: ReportsIndex = { reports: scanReports(root).map((report) => report.summary) };
	if (!Value.Check(ReportsIndexSchema, index)) {
		throw new Error("Generated reports index violates the contracts schema");
	}
	return index;
}

/**
 * One Markdown file of a report. The id, kind and file name are accepted only when they name a report this index lists,
 * so a request never turns into an arbitrary host file read.
 */
export function readReportFile(root: string, id: string, kind: string, name: string): ReportFile | undefined {
	const report = scanReports(root).find(
		(entry) =>
			entry.summary.id === id && entry.summary.kind === kind && entry.summary.files.some((file) => file.name === name),
	);
	if (!report) return undefined;
	const filePath = path.join(report.folder, name);
	if (isSymlink(filePath)) return undefined;
	try {
		const markdown = fs.readFileSync(filePath, "utf8");
		if (Buffer.byteLength(markdown) > MAX_REPORT_FILE_BYTES) return undefined;
		const payload: ReportFile = { id, kind: report.summary.kind, file: name, markdown };
		if (!Value.Check(ReportFileSchema, payload)) {
			throw new Error("Generated report file payload violates the contracts schema");
		}
		return payload;
	} catch {
		return undefined;
	}
}
