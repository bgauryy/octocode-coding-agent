import type { BashFileTarget } from "../bash-types.ts";
import { resolveToolPath } from "../../shared/home.ts";
import type { SourcePermissionMode } from "../../shared/permission-updates.ts";
import { isRecord } from "../../../utils/guards.ts";

type Behavior = "deny" | "ask" | "allow";
export interface PolicySource {
	path: string;
	anchor: string;
}
export interface Rule {
	behavior: Behavior;
	tool: string;
	specifier?: string;
	source: PolicySource;
	invalid?: boolean;
}
export interface SourcePolicy {
	rules: Rule[];
	errors: string[];
	defaultMode?: SourcePermissionMode;
	additionalDirectories?: string[];
}
export interface SourceDecision {
	decision: Behavior | "none" | "unsupported";
	message?: string;
	shellTargets?: Array<BashFileTarget & { allowed: boolean }>;
	shellBroadAllowance?: boolean;
	dontAsk?: boolean;
}

export function parseSourcePolicy(value: unknown, source: PolicySource): SourcePolicy {
	const result: SourcePolicy = { rules: [], errors: [] };
	if (!isRecord(value)) {
		result.errors.push(`${source.path}: settings must be an object`);
		result.rules.push({ behavior: "deny", tool: "*", source, invalid: true });
		return result;
	}
	if (value.permissions === undefined) return result;
	const permissions = value.permissions;
	if (!isRecord(permissions)) {
		result.errors.push(`${source.path}: permissions must be an object`);
		result.rules.push({ behavior: "deny", tool: "*", source, invalid: true });
		return result;
	}
	for (const key of Object.keys(permissions)) {
		if (!["deny", "ask", "allow", "defaultMode", "additionalDirectories"].includes(key))
			result.errors.push(`${source.path}: permissions.${key} is not supported by this policy adapter`);
	}
	const mode = permissions.defaultMode;
	if (mode !== undefined) {
		if (typeof mode === "string" && ["default", "manual", "acceptEdits", "dontAsk"].includes(mode))
			result.defaultMode = mode === "manual" ? "default" : (mode as SourcePermissionMode);
		else
			result.errors.push(
				`${source.path}: unsupported source permission mode ${typeof mode === "string" ? mode : JSON.stringify(mode)}`,
			);
	}
	if (permissions.additionalDirectories !== undefined) {
		const dirs = permissions.additionalDirectories;
		if (
			!Array.isArray(dirs) ||
			dirs.length > 4096 ||
			dirs.some((dir) => typeof dir !== "string" || !dir || dir.length > 8192)
		)
			result.errors.push(`${source.path}: invalid additionalDirectories`);
		else result.additionalDirectories = dirs.map((dir) => resolveToolPath(source.anchor, dir));
	}
	for (const behavior of ["deny", "ask", "allow"] as const) {
		const values = permissions[behavior];
		if (values === undefined) continue;
		if (!Array.isArray(values) || values.length > 4096) {
			result.errors.push(`${source.path}: permissions.${behavior} must be a bounded array`);
			if (behavior !== "allow") result.rules.push({ behavior, tool: "*", source, invalid: true });
			continue;
		}
		for (const raw of values) {
			const parsed = typeof raw === "string" && raw.length <= 8192 ? /^([^()\s]+)(?:\((.*)\))?$/s.exec(raw) : null;
			if (!parsed) {
				result.errors.push(`${source.path}: invalid permissions.${behavior} rule`);
				if (behavior !== "allow") result.rules.push({ behavior, tool: "*", source, invalid: true });
				continue;
			}
			const [, tool, specifier] = parsed;
			if (
				(tool.startsWith("mcp__") && specifier !== undefined) ||
				(behavior === "allow" && tool.includes("*") && !/^mcp__[^*]+__[^]*$/.test(tool))
			) {
				result.errors.push(`${source.path}: unsupported permissions.${behavior} rule`);
				continue;
			}
			if (
				behavior !== "allow" &&
				specifier &&
				primaryParameter(tool, specifier.split(":", 1)[0].trim()) &&
				specifier.includes(":")
			) {
				result.errors.push(`${source.path}: primary-content parameter selector is ignored; use the tool's rule syntax`);
				continue;
			}
			result.rules.push({ behavior, tool: tool, specifier, source });
		}
	}
	return result;
}
export function primaryParameter(tool: string, key: string): boolean {
	return (
		(
			{
				Bash: "command",
				PowerShell: "command",
				Read: "file_path",
				Edit: "file_path",
				Write: "file_path",
				Grep: "path",
				Glob: "path",
				NotebookEdit: "notebook_path",
				WebFetch: "url",
			} as Record<string, string>
		)[tool] === key
	);
}
export function wildcard(pattern: string, value: string): boolean {
	let p = 0,
		v = 0,
		star = -1,
		retry = 0;
	while (v < value.length) {
		if (p < pattern.length && pattern[p] === value[v] && pattern[p] !== "*") {
			p++;
			v++;
		} else if (pattern[p] === "*") {
			star = p++;
			retry = v;
		} else if (star >= 0) {
			p = star + 1;
			v = ++retry;
		} else return false;
	}
	while (pattern[p] === "*") p++;
	return p === pattern.length;
}

export function names(tool: string): string[] {
	return (
		(
			{
				bash: process.platform === "win32" ? ["Bash", "PowerShell"] : ["Bash"],
				powershell: ["PowerShell"],
				read: ["Read"],
				edit: ["Edit"],
				write: ["Write"],
				file: ["Write", "Edit", "Delete"],
				grep: ["Grep"],
				find: ["Glob"],
				ls: ["LS"],
				web: ["WebFetch", "WebSearch"],
				agent: ["Agent", "agent.message", "agent.coordinate"],
			} as Record<string, string[]>
		)[tool] ?? [tool]
	);
}
export function toolMatches(rule: Rule, name: string): boolean {
	if (wildcard(rule.tool, name)) return true;
	return rule.tool.startsWith("mcp__") && !rule.tool.slice(5).includes("__") && name.startsWith(`${rule.tool}__`);
}
