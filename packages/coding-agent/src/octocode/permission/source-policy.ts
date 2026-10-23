import fs from "node:fs";
import { bashSyntax } from "./bash-syntax.ts";
import type { BashCommand, BashFileTarget } from "./bash-types.ts";
import { bashCandidates, needsBashTokens } from "./bash-wrappers.ts";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import type { ToolInvocation } from "../../core/extensions/types.ts";
import { fileChanges } from "../shared/file-input.ts";
import { canonicalPath, isWithin, resolveToolPath } from "../shared/home.ts";
import { runsLater, stateFolderRefusal } from "./file-access.ts";
import type { SourcePermissionMode } from "../shared/permission-updates.ts";
import { isRecord } from "../shared/util.ts";

type Behavior = "deny" | "ask" | "allow";
export interface PolicySource {
	path: string;
	anchor: string;
}
interface Rule {
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
	if (permissions.defaultMode !== undefined) {
		if (["default", "manual", "acceptEdits", "dontAsk"].includes(String(permissions.defaultMode)))
			result.defaultMode =
				permissions.defaultMode === "manual" ? "default" : (permissions.defaultMode as SourcePermissionMode);
		else result.errors.push(`${source.path}: unsupported source permission mode ${String(permissions.defaultMode)}`);
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
				(tool!.startsWith("mcp__") && specifier !== undefined) ||
				(behavior === "allow" && tool!.includes("*") && !/^mcp__[^*]+__[^]*$/.test(tool!))
			) {
				result.errors.push(`${source.path}: unsupported permissions.${behavior} rule`);
				continue;
			}
			if (
				behavior !== "allow" &&
				specifier &&
				primaryParameter(tool!, specifier.split(":", 1)[0]!.trim()) &&
				specifier.includes(":")
			) {
				result.errors.push(`${source.path}: primary-content parameter selector is ignored; use the tool's rule syntax`);
				continue;
			}
			result.rules.push({ behavior, tool: tool!, specifier, source });
		}
	}
	return result;
}
function primaryParameter(tool: string, key: string): boolean {
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
function wildcard(pattern: string, value: string): boolean {
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

function names(tool: string): string[] {
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
function toolMatches(rule: Rule, name: string): boolean {
	if (wildcard(rule.tool, name)) return true;
	return rule.tool.startsWith("mcp__") && !rule.tool.slice(5).includes("__") && name.startsWith(`${rule.tool}__`);
}
export function sourceToolDenied(policy: SourcePolicy, name: string): boolean {
	return names(name).every((sourceName) =>
		policy.rules.some(
			(rule) =>
				!rule.invalid &&
				rule.behavior === "deny" &&
				(rule.specifier === undefined || rule.specifier === "*") &&
				toolMatches(rule, sourceName),
		),
	);
}
interface Operation {
	wholeAllow?: boolean;
	shellCommand?: BashCommand;
	wholeCommand?: string;
	name: string;
	input: Record<string, unknown>;
	path?: string;
	mutation?: boolean;
}
function operations(invocation: ToolInvocation): Operation[] {
	const input = isRecord(invocation.input) ? invocation.input : {};
	if (invocation.toolName === "file")
		return fileChanges(input).flatMap((query) => {
			const name = query.type === "write" ? "Write" : query.type === "delete" ? "Delete" : "Edit";
			return [
				{
					name,
					input: query,
					path: typeof query.path === "string" ? query.path : undefined,
					mutation: true,
				},
				...(typeof query.movePath === "string"
					? [
							{
								name: "Write",
								input: query,
								path: query.movePath,
								mutation: true,
							},
						]
					: []),
			];
		});
	if (invocation.toolName === "agent")
		return [
			{
				name: input.type === "task" ? "Agent" : `agent.${String(input.type ?? "unknown")}`,
				input: isRecord(input.input) ? input.input : input,
			},
		];
	if (invocation.toolName === "bash") return [{ name: input.type === "powershell" ? "PowerShell" : "Bash", input }];
	if (invocation.toolName === "web") return [{ name: typeof input.url === "string" ? "WebFetch" : "WebSearch", input }];
	return names(invocation.toolName).map((name) => ({
		name,
		input,
		path:
			typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined,
		mutation: ["Edit", "Write", "Delete"].includes(name),
	}));
}
function realCandidate(value: string): string {
	try {
		return fs.realpathSync(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const canonical = canonicalPath(value);
		if (canonical !== value) return realCandidate(canonical);
		const parent = path.dirname(value);
		if (parent === value) throw error;
		return path.join(realCandidate(parent), path.basename(value));
	}
}
function pathMatch(rule: Rule, target: string, cwd: string): boolean | undefined {
	const specifier = rule.specifier!;
	// Ordered negation needs a group evaluator; until then it cannot authorize or erase a restriction.
	if (specifier.startsWith("!")) return undefined;
	let anchor = cwd,
		pattern = specifier;
	if (pattern.startsWith("//")) {
		anchor = path.parse(cwd).root;
		pattern = pattern.slice(2);
	} else if (pattern.startsWith("~/")) {
		anchor = os.homedir();
		pattern = pattern.slice(2);
	} else if (pattern.startsWith("/")) {
		anchor = rule.source.anchor;
		pattern = pattern.slice(1);
	} else pattern = pattern.replace(/^\.\//, "");
	const matches = (root: string, file: string, candidatePattern = pattern): boolean => {
		const relative = path.relative(root, file).split(path.sep).join("/");
		if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return false;
		if (!relative) return false;
		let adapted = candidatePattern;
		if (rule.behavior !== "allow" && /^[^/]+\/\*\*$/.test(adapted) && !specifier.startsWith("/"))
			adapted = `**/${adapted}`;
		try {
			return ignore().add(adapted).ignores(relative);
		} catch {
			return rule.behavior !== "allow" && relative === pattern;
		}
	};
	try {
		const requested = resolveToolPath(cwd, target),
			actual = realCandidate(requested);
		const requestedMatch = matches(anchor, requested);
		let resolvedMatch = matches(anchor, actual) || matches(realCandidate(anchor), actual);
		if (!resolvedMatch && rule.behavior !== "allow" && (specifier.startsWith("/") || specifier.startsWith("~/"))) {
			const magic = pattern.search(/[*?\[\\]/);
			if (magic < 0) resolvedMatch = realCandidate(path.resolve(anchor, pattern)) === actual;
			else {
				const slash = pattern.lastIndexOf("/", magic);
				if (slash >= 0)
					resolvedMatch = matches(
						realCandidate(path.resolve(anchor, pattern.slice(0, slash))),
						actual,
						pattern.slice(slash + 1),
					);
			}
		}
		return rule.behavior === "allow" ? requestedMatch && resolvedMatch : requestedMatch || resolvedMatch;
	} catch {
		return undefined;
	}
}
function match(rule: Rule, operation: Operation, cwd: string): boolean | undefined {
	const fileRule =
		(rule.tool === "Edit" && operation.mutation) ||
		(rule.specifier !== undefined &&
			rule.tool === "Read" &&
			(operation.name === "Read" || (rule.behavior === "deny" && operation.mutation)));
	if (!toolMatches(rule, operation.name) && !fileRule) return false;
	if (rule.invalid) return undefined;
	const specifier = rule.specifier;
	if (specifier === undefined || specifier === "*") return true;
	if (["Read", "Edit"].includes(rule.tool)) return operation.path ? pathMatch(rule, operation.path, cwd) : undefined;
	if (["Write", "NotebookEdit", "Glob", "MultiEdit"].includes(rule.tool)) return false;
	if (rule.tool === "WebFetch" && specifier.startsWith("domain:")) {
		if (typeof operation.input.url !== "string") return undefined;
		try {
			const host = new URL(operation.input.url).hostname.toLowerCase().replace(/\.$/, "");
			const pattern = specifier.slice(7).toLowerCase().replace(/\.$/, "");
			if (pattern === "*") return true;
			if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1)) && host !== pattern.slice(2);
			const labels = pattern.split("."),
				actual = host.split(".");
			return labels.length === actual.length && labels.every((label, index) => wildcard(label, actual[index]!));
		} catch {
			return undefined;
		}
	}
	const parameter = /^([A-Za-z_$][\w$.-]*)\s*:\s*(.*)$/s.exec(specifier);
	if (parameter && rule.behavior !== "allow" && !specifier.endsWith(":*")) {
		const key = parameter[1]!.trim();
		if (primaryParameter(rule.tool, key)) return false;
		const value = operation.input[key];
		return ["string", "number", "boolean"].includes(typeof value) && wildcard(parameter[2]!.trim(), String(value));
	}
	if (rule.tool === "Bash" || rule.tool === "PowerShell") {
		const command = operation.input.command;
		if (typeof command !== "string") return undefined;
		// PowerShell needs its own AST and source matching rules.
		if (rule.tool === "PowerShell") return undefined;
		let pattern = specifier.endsWith(":*") ? `${specifier.slice(0, -2)} *` : specifier;
		const projected = operation.shellCommand
			? bashCandidates(operation.shellCommand, rule.behavior)
			: {
					candidates: [command],
					prefixApprovalBlocked: false,
					unsupported: false,
				};
		if (rule.behavior === "allow" && pattern.includes("*") && projected.prefixApprovalBlocked) return false;
		const matched =
			projected.candidates.some(
				(candidate) =>
					wildcard(pattern, candidate) ||
					(pattern.endsWith(" *") && pattern.indexOf("*") === pattern.length - 1 && candidate === pattern.slice(0, -2)),
			) ||
			((rule.behavior === "deny" ||
				(rule.behavior === "allow" &&
					operation.wholeAllow &&
					operation.wholeCommand === operation.wholeCommand?.trimStart())) &&
				operation.wholeCommand !== undefined &&
				pattern === operation.wholeCommand);
		return matched || (projected.unsupported ? undefined : false);
	}
	if (rule.tool === "Agent") {
		const role = operation.input.profile ?? operation.input.role ?? operation.input.agent;
		return typeof role === "string" ? wildcard(specifier, role) : undefined;
	}
	return undefined;
}
export function evaluateSourcePolicy(policy: SourcePolicy, invocation: ToolInvocation, cwd: string): SourceDecision {
	let calls: Operation[];
	try {
		calls = operations(invocation);
	} catch {
		return {
			decision: "unsupported",
			message: "Cannot project invocation for source permission policy",
		};
	}
	if (!calls.length && policy.rules.length)
		return {
			decision: "unsupported",
			message: "Cannot project invocation for source permission policy",
		};
	let shellIncomplete = false;
	let shellFileEffects = false;
	const shellTargets: NonNullable<SourceDecision["shellTargets"]> = [];
	const targetDecisions: SourceDecision[] = [];
	const scopedBash = policy.rules.some(
		(rule) => rule.tool === "Bash" && rule.specifier !== undefined && rule.specifier !== "*",
	);
	const fileRules = policy.rules.filter(
		(rule) =>
			["Read", "Edit"].includes(rule.tool) &&
			rule.behavior !== "ask" &&
			rule.specifier !== undefined &&
			rule.specifier !== "*",
	);
	const broadBashAllow = policy.rules.some(
		(rule) =>
			rule.behavior === "allow" && rule.tool === "Bash" && (rule.specifier === undefined || rule.specifier === "*"),
	);
	{
		calls = calls.flatMap((operation) => {
			if (operation.name !== "Bash" || typeof operation.input.command !== "string") return [operation];
			const text = operation.input.command;
			if (
				Buffer.byteLength(text) <= 128 * 1024 &&
				!needsBashTokens(text) &&
				!/^\s*(?:tee|cat|head|tail|wc)\b/.test(text) &&
				/^[\w .,/=:~+@%*-]+$/.test(text)
			)
				return [operation];
			const syntax = bashSyntax(text);
			shellIncomplete ||= syntax.incomplete && (scopedBash || fileRules.some((rule) => rule.behavior === "deny"));
			shellFileEffects ||= syntax.targets.some((target) => !target.policyOnly);
			for (const target of syntax.targets) {
				const eligible = fileRules.filter(
					(rule) =>
						rule.tool === (target.kind === "read" ? "Read" : "Edit") &&
						(!target.policyOnly || rule.behavior === "deny"),
				);
				let decision: SourceDecision = { decision: "none" };
				for (const behavior of ["deny", "allow"] as const) {
					for (const rule of eligible.filter((rule) => rule.behavior === behavior)) {
						const matched = !target.uncertain && target.path ? pathMatch(rule, target.path, cwd) : undefined;
						if (matched === true) {
							decision = {
								decision: behavior,
								message: `Claude permission ${behavior}: ${rule.source.path} (${rule.tool})`,
							};
							break;
						}
						if (matched === undefined && behavior !== "allow") {
							decision = {
								decision: "unsupported",
								message: `Cannot resolve Bash file target for ${rule.tool} rule in ${rule.source.path}`,
							};
							break;
						}
					}
					if (decision.decision !== "none") break;
				}
				if (!target.policyOnly)
					shellTargets.push({
						...target,
						allowed: decision.decision === "allow",
					});
				if (decision.decision !== "allow") targetDecisions.push(decision);
			}
			if (!scopedBash) return [operation];
			return syntax.commands.map((command) => ({
				...operation,
				wholeCommand: text,
				wholeAllow: syntax.wholeAllow,
				shellCommand: command,
				input: { ...operation.input, command: command.raw },
			}));
		});
	}
	const results = calls.map((operation) => {
		for (const behavior of ["deny", "ask", "allow"] as const) {
			for (const rule of policy.rules.filter((rule) => rule.behavior === behavior)) {
				const matched = match(rule, operation, cwd);
				if (matched === true)
					return {
						decision: behavior,
						message: `Claude permission ${behavior}: ${rule.source.path} (${rule.tool})`,
					} as SourceDecision;
				if (matched === undefined && behavior !== "allow")
					return {
						decision: "unsupported",
						message: `Unsupported applicable Claude permission rule in ${rule.source.path} (${rule.tool})`,
					} as SourceDecision;
			}
		}
		return { decision: "none" } as SourceDecision;
	});
	results.push(...targetDecisions.filter((decision) => decision.decision !== "none"));
	let decision: SourceDecision =
		results.find((value) => value.decision === "deny") ??
		(shellIncomplete
			? {
					decision: "unsupported" as const,
					message: "Unsupported or incomplete Bash syntax for source permission policy",
				}
			: undefined) ??
		results.find((value) => value.decision === "unsupported") ??
		results.find((value) => value.decision === "ask") ??
		(results.length > 0 &&
		(!shellFileEffects || broadBashAllow || shellTargets.every((target) => target.allowed)) &&
		results.every((value) => value.decision === "allow")
			? { decision: "allow" }
			: { decision: "none" });
	// acceptEdits allows a call whose every operation edits a path inside the workspace or an added directory.
	if (decision.decision === "none" && policy.defaultMode === "acceptEdits") {
		const roots = [canonicalPath(cwd), ...(policy.additionalDirectories ?? []).map(canonicalPath)];
		const actual = operations(invocation);
		const editsInside = (op: (typeof actual)[number]): boolean => {
			if (!op.mutation || !op.path) return false;
			const file = canonicalPath(resolveToolPath(cwd, op.path));
			return (
				!stateFolderRefusal(file, op.path, op.name) &&
				roots.some((root) => isWithin(file, root) && !runsLater(file, root))
			);
		};
		if (actual.length > 0 && actual.every(editsInside)) decision = { decision: "allow" };
	}
	if (policy.defaultMode === "dontAsk") decision = { ...decision, dontAsk: true };
	return shellTargets.length ? { ...decision, shellTargets, shellBroadAllowance: broadBashAllow } : decision;
}

export function unprojectedSourcePolicy(policy: SourcePolicy, toolName: string): SourceDecision {
	const categories = names(toolName);
	if (toolName === "file") categories.push("Read");
	const restricted = policy.rules.find(
		(rule) => rule.behavior !== "allow" && categories.some((name) => toolMatches(rule, name)),
	);
	return restricted
		? {
				decision: "unsupported",
				message: `Cannot project input for Claude permission policy (${restricted.source.path})`,
			}
		: { decision: "none" };
}
