import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import type { ToolInvocation } from "../../../core/features/types.ts";
import { agentCall } from "../../child-sessions/agent-call.ts";
import { fileChanges } from "../../tool-input/file-input.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { canonicalPath } from "../../../../../common/src/canonical-path.ts";
import { untilCommand } from "../../shared/until-command.ts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { BashCommand } from "../bash-types.ts";
import { bashCandidates } from "../bash-wrappers.ts";
import { names, primaryParameter, type Rule, toolMatches, wildcard } from "./rules.ts";

export interface Operation {
	wholeAllow?: boolean;
	shellCommand?: BashCommand;
	wholeCommand?: string;
	name: string;
	input: Record<string, unknown>;
	path?: string;
	mutation?: boolean;
}
export function operations(invocation: ToolInvocation): Operation[] {
	const input = asRecord(invocation.input);
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
	if (invocation.toolName === "agent") {
		const call = agentCall(input);
		return [{ name: call.type === "task" ? "Agent" : `agent.${call.type ?? "unknown"}`, input: call.input }];
	}
	if (invocation.toolName === "bash") return [{ name: input.type === "powershell" ? "PowerShell" : "Bash", input }];
	// A timer's until-command runs as the bash call it is: the call is both `timer` and `Bash`, so a deny or ask on either
	// name applies and an allow needs both. A timer without one is only a `timer` call.
	const command = invocation.toolName === "timer" ? untilCommand(input) : undefined;
	if (command)
		return [
			{ name: "timer", input },
			{ name: "Bash", input: { command } },
		];
	if (invocation.toolName === "web") return [{ name: typeof input.url === "string" ? "WebFetch" : "WebSearch", input }];
	return names(invocation.toolName).map((name) => ({
		name,
		input,
		path:
			typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined,
		mutation: ["Edit", "Write", "Delete"].includes(name),
	}));
}
/** The resolved path the filesystem holds, in its on-disk letter case (`realpathSync.native`), so a respelled directory on a case-insensitive volume still meets a deny rule. */
function realCandidate(value: string): string {
	try {
		return fs.realpathSync.native(value);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const canonical = canonicalPath(value);
		if (canonical !== value) return realCandidate(canonical);
		const parent = path.dirname(value);
		if (parent === value) throw error;
		return path.join(realCandidate(parent), path.basename(value));
	}
}
export function pathMatch(rule: Rule, target: string, cwd: string): boolean | undefined {
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
		// An allow rule matches the case it names (on a case-sensitive filesystem `DOCS/` is another directory); deny and ask match any.
		try {
			return ignore({ ignorecase: rule.behavior !== "allow" })
				.add(adapted)
				.ignores(relative);
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
			const magic = pattern.search(/[*?[\\]/);
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
export function match(rule: Rule, operation: Operation, cwd: string): boolean | undefined {
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
			return labels.length === actual.length && labels.every((label, index) => wildcard(label, actual[index]));
		} catch {
			return undefined;
		}
	}
	const parameter = /^([A-Za-z_$][\w$.-]*)\s*:\s*(.*)$/s.exec(specifier);
	if (parameter && rule.behavior !== "allow" && !specifier.endsWith(":*")) {
		const key = parameter[1].trim();
		if (primaryParameter(rule.tool, key)) return false;
		const value = operation.input[key];
		return ["string", "number", "boolean"].includes(typeof value) && wildcard(parameter[2].trim(), String(value));
	}
	if (rule.tool === "Bash" || rule.tool === "PowerShell") {
		const command = operation.input.command;
		if (typeof command !== "string") return undefined;
		// PowerShell needs its own AST and source matching rules.
		if (rule.tool === "PowerShell") return undefined;
		const pattern = specifier.endsWith(":*") ? `${specifier.slice(0, -2)} *` : specifier;
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
