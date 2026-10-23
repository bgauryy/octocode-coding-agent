import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWriteFile, sha256 } from "../../utils/atomic-file.ts";
import { canonicalPath } from "../shared/home.ts";
import { isRecord } from "../shared/util.ts";
import {
	applyRuleUpdates,
	type SourcePermissionDestination,
	type SourcePermissionUpdate,
	type SourceRuleArrays,
} from "../shared/permission-updates.ts";
import type { PolicySource } from "./source-policy.ts";

export function localPermissionAllowances(file: string): boolean {
	if (path.basename(file) !== "settings.local.json") return false;
	try {
		if (
			fs.lstatSync(path.dirname(file)).isSymbolicLink() ||
			fs.lstatSync(file).isSymbolicLink()
		)
			return false;
		let directory = path.dirname(path.dirname(file));
		while (!fs.existsSync(path.join(directory, ".git"))) {
			const parent = path.dirname(directory);
			if (parent === directory) return true;
			directory = parent;
		}
		const tracked = execFileSync(
			"git",
			["ls-files", "-z", "--", path.relative(directory, file)],
			{
				cwd: directory,
				encoding: "utf8",
				timeout: 2000,
				maxBuffer: 1024 * 1024,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			},
		);
		return tracked.length === 0;
	} catch {
		return false;
	}
}

interface SettingsWrite {
	source: PolicySource;
	destination: SourcePermissionDestination;
	settings: Record<string, unknown>;
	expectedSha: string | null;
	before?: string;
	canonical: string;
	preparationError?: string;
}
export function stageSettingsWrite(
	source: PolicySource,
	destination: SourcePermissionDestination,
	updates: readonly SourcePermissionUpdate[],
): SettingsWrite {
	const captured = readPolicy(source.path);
	let settings: Record<string, unknown> = {};
	let preparationError = captured.error
		? `Cannot read regular settings file ${source.path}`
		: undefined;
	if (captured.text !== undefined) {
		try {
			const parsed: unknown = JSON.parse(captured.text);
			if (!isRecord(parsed)) throw new Error("settings must be an object");
			settings = parsed;
		} catch {
			preparationError = `Invalid settings JSON at ${source.path}`;
		}
	}
	const existing = settings.permissions;
	if (existing !== undefined && !isRecord(existing))
		throw new Error(`Invalid permissions object at ${source.path}`);
	const permissions = isRecord(existing) ? existing : {};
	const arrays: SourceRuleArrays = { allow: [], deny: [], ask: [] };
	for (const behavior of ["allow", "deny", "ask"] as const) {
		const entries = permissions[behavior];
		if (
			entries !== undefined &&
			(!Array.isArray(entries) ||
				entries.length > 4096 ||
				entries.some((entry) => typeof entry !== "string"))
		)
			throw new Error(`Invalid ${behavior} rules at ${source.path}`);
		arrays[behavior] = entries === undefined ? [] : [...(entries as string[])];
	}
	if(permissions.additionalDirectories!==undefined && (!Array.isArray(permissions.additionalDirectories)||permissions.additionalDirectories.some(dir=>typeof dir!=="string"||!dir)))throw new Error(`Invalid additionalDirectories at ${source.path}`);
 const next = applyRuleUpdates({ ...arrays, ...(permissions.defaultMode === undefined ? {} : {defaultMode: permissions.defaultMode as SourceRuleArrays["defaultMode"]}), ...(permissions.additionalDirectories === undefined ? {} : {additionalDirectories: permissions.additionalDirectories as string[]}) }, updates, destination);
	settings = { ...settings, permissions: { ...permissions, ...next } };
	if (Buffer.byteLength(JSON.stringify(settings)) > 1024 * 1024)
		throw new Error("Permission settings exceed the byte limit");
	return {
		source,
		destination,
		settings,
		expectedSha: captured.text === undefined ? null : sha256(captured.text),
		...(captured.text === undefined ? {} : { before: captured.text }),
		canonical: canonicalPath(source.path),
		...(preparationError ? { preparationError } : {}),
	};
}
export async function persistSettingsWrite(
	plan: SettingsWrite,
	signal: AbortSignal,
): Promise<
	{ written: true; message?: string } | { written: false; message: string }
> {
	signal.throwIfAborted();
	if (plan.preparationError)
		return { written: false, message: plan.preparationError };
	try {
		await fs.promises.mkdir(path.dirname(plan.source.path), {
			recursive: true,
			mode: 0o700,
		});
		signal.throwIfAborted();
		await atomicWriteFile(
			plan.source.path,
			`${JSON.stringify(plan.settings, null, 2)}\n`,
			plan.expectedSha,
			{
				signal,
				beforeCommit: () => {
					if (canonicalPath(plan.source.path) !== plan.canonical)
						throw new Error("Permission settings target identity changed");
				},
			},
		);
		return { written: true };
	} catch (error) {
		if (
			error instanceof Error &&
			"mutationCompleted" in error &&
			error.mutationCompleted === true
		)
			return { written: true, message: error.message };
		signal.throwIfAborted();
		if (!(error instanceof Error) || !("code" in error)) throw error;
		return {
			written: false,
			message: `Permission settings were not saved at ${plan.source.path}: ${error.message}`,
		};
	}
}

export function readPolicy(file: string): { text?: string; error?: boolean } {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		if (!fs.fstatSync(fd).isFile()) return { error: true };
		const bytes = Buffer.alloc(1024 * 1024 + 1);
		let count = 0;
		while (count < bytes.length) {
			const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
			if (!read) break;
			count += read;
		}
		if (count === bytes.length) return { error: true };
		return {
			text: new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, count),
			),
		};
	} catch (error) {
		return { error: (error as NodeJS.ErrnoException).code !== "ENOENT" };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
