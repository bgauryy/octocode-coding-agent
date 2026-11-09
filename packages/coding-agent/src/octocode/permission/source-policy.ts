import { bashSyntax } from "./bash-syntax.ts";
import { needsBashTokens } from "./bash-wrappers.ts";
import type { ToolInvocation } from "../../core/features/types.ts";
import { resolveToolPath } from "../shared/home.ts";
import { runsLater, stateFolderRefusal } from "./file-access.ts";
import { match, type Operation, operations, pathMatch } from "./source-policy/match.ts";
import { names, type SourceDecision, type SourcePolicy, toolMatches } from "./source-policy/rules.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { isWithin } from "../../../../common/src/paths.ts";

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
	// The first construct the Bash parser does not model, in any command of this call.
	let shellUnsupported: string | undefined;
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
	// Only a restriction refuses syntax it cannot see through; an allow-only policy merely withholds its grant.
	const restriction = policy.rules.find(
		(rule) =>
			(rule.tool === "Bash" && rule.behavior !== "allow" && rule.specifier !== undefined && rule.specifier !== "*") ||
			(fileRules.includes(rule) && rule.behavior === "deny"),
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
			if (syntax.incomplete) shellUnsupported ??= syntax.unsupported ?? "unknown construct";
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
	const results = calls.map((operation): SourceDecision => {
		for (const behavior of ["deny", "ask", "allow"] as const) {
			for (const rule of policy.rules.filter((rule) => rule.behavior === behavior)) {
				const matched = match(rule, operation, cwd);
				if (matched === true)
					return {
						decision: behavior,
						message: `Claude permission ${behavior}: ${rule.source.path} (${rule.tool})`,
					};
				if (matched === undefined && behavior !== "allow")
					return {
						decision: "unsupported",
						message: `Unsupported applicable Claude permission rule in ${rule.source.path} (${rule.tool})`,
					};
			}
		}
		return { decision: "none" };
	});
	results.push(...targetDecisions.filter((decision) => decision.decision !== "none"));
	let decision: SourceDecision =
		results.find((value) => value.decision === "deny") ??
		(shellUnsupported !== undefined && restriction
			? {
					decision: "unsupported" as const,
					message: `Bash syntax the source permission policy cannot check (${shellUnsupported}), refused under the Claude permission ${restriction.behavior} rule in ${restriction.source.path} (${restriction.tool}); run simple commands or a script file instead`,
				}
			: undefined) ??
		results.find((value) => value.decision === "unsupported") ??
		results.find((value) => value.decision === "ask") ??
		(results.length > 0 &&
		(shellUnsupported === undefined || broadBashAllow) &&
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
				!stateFolderRefusal(file, op.path, op.name, cwd) &&
				roots.some((root) => isWithin(file, root) && !runsLater(file, root))
			);
		};
		if (actual.length > 0 && actual.every(editsInside)) decision = { decision: "allow" };
	}
	if (policy.defaultMode === "dontAsk") decision = { ...decision, dontAsk: true };
	// `shellBroadAllowance` also covers the write targets `checkPermission` adds for command operands.
	if (shellTargets.length) return { ...decision, shellTargets, shellBroadAllowance: broadBashAllow };
	return broadBashAllow ? { ...decision, shellBroadAllowance: true } : decision;
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
