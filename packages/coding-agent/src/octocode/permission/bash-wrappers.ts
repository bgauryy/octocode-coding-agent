import type { BashCommand } from "./bash-types.ts";

const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "command", "builtin", "noglob", "xargs"]);
const EXEC_WRAPPERS = new Set(["watch", "setsid", "ionice", "flock"]);
const FIND_EFFECTS = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-delete",
	"-rm",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-files0-from",
]);
const SAFE_ASSIGNMENTS = new Set(["NODE_ENV"]);

interface BashCandidates {
	candidates: string[];
	executables: number[];
	prefixApprovalBlocked: boolean;
	unsupported: boolean;
}

/** Source-rule candidates retain raw spelling; this is not the native destructive-command classifier. */
export function bashCandidates(command: BashCommand, behavior: "deny" | "ask" | "allow"): BashCandidates {
	const result = projectCandidates(command, behavior);
	if (command.tokens.some((token) => token.literal !== undefined && token.literal !== token.raw)) {
		const literalOptions = projectCandidates(
			{
				...command,
				tokens: command.tokens.map((token) => ({
					...token,
					raw: token.literal ?? token.raw,
				})),
			},
			behavior,
		);
		result.prefixApprovalBlocked ||= literalOptions.prefixApprovalBlocked;
		result.executables = [...new Set([...result.executables, ...literalOptions.executables])];
	}
	return result;
}

function projectCandidates(command: BashCommand, behavior: "deny" | "ask" | "allow"): BashCandidates {
	const result: BashCandidates = {
		candidates: [command.raw],
		executables: [0],
		prefixApprovalBlocked: false,
		unsupported: false,
	};
	const words = command.tokens.map((token) => token.raw);
	const normalizedAt = (index: number) => {
		const token = command.tokens[index];
		return (token.literal ?? token.raw) + command.raw.slice(token.end);
	};
	if (command.tokens[0]?.literal !== undefined)
		result.candidates.push(command.raw.slice(0, command.tokens[0].start) + normalizedAt(0));
	const blockedAssignments =
		behavior === "allow" && command.assignments.some((assignment) => !SAFE_ASSIGNMENTS.has(assignment.name));
	if (!blockedAssignments && command.assignments.length && words.length) result.candidates.push(normalizedAt(0));
	let cursor = 0;
	for (let depth = 0; depth < 32 && cursor < words.length; depth++) {
		const wrapper = command.tokens[cursor].literal ?? words[cursor];
		if (
			EXEC_WRAPPERS.has(wrapper) ||
			(wrapper === "find" &&
				command.tokens
					.slice(cursor + 1)
					.some((token) => token.literal === undefined || FIND_EFFECTS.has(token.literal)))
		)
			result.prefixApprovalBlocked = true;
		if (!WRAPPERS.has(wrapper)) break;
		if (command.ambiguousRedirect) {
			result.unsupported = true;
			break;
		}
		let next = cursor + 1;
		if (wrapper === "command" && ["-v", "-V"].includes(words[next] ?? "")) break;
		if (wrapper === "xargs" && words[next]?.startsWith("-")) break;
		if (wrapper === "nice") {
			if (words[next] === "-n") next += 2;
			else if (words[next]?.startsWith("-")) break;
		} else if (wrapper === "time") {
			if (words[next] === "-p" && behavior !== "allow") next++;
			else if (words[next]?.startsWith("-")) break;
		} else if (wrapper === "command") {
			if (words[next] === "-p") next++;
		} else if (wrapper === "timeout") {
			while (words[next]?.startsWith("-")) {
				const option = words[next];
				if (option === "--") {
					next++;
					break;
				}
				if (["-s", "-k", "--signal", "--kill-after"].includes(option)) {
					next += 2;
					continue;
				}
				if (
					/^--(?:signal|kill-after)=.+$/.test(option) ||
					["--foreground", "--preserve-status", "-v", "--verbose"].includes(option)
				) {
					next++;
					continue;
				}
				result.unsupported = true;
				break;
			}
			if (result.unsupported) break;
			if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words[next] ?? "")) {
				result.unsupported = true;
				break;
			}
			next++;
		} else if (wrapper === "stdbuf") {
			if (/^--(?:input|output|error)(?:=|$)/.test(words[next] ?? "") || ["-i", "-o", "-e"].includes(words[next] ?? ""))
				break;
			while (/^-[ioe].+/.test(words[next] ?? "")) next++;
		}
		if (words[next] === "--") next++;
		if (!words[next] || words[next].startsWith("-")) {
			result.unsupported = true;
			break;
		}
		cursor = next;
		result.executables.push(cursor);
		if (!blockedAssignments) result.candidates.push(normalizedAt(cursor));
		if (depth === 31 && WRAPPERS.has(command.tokens[cursor].literal ?? words[cursor])) result.unsupported = true;
	}
	return result;
}

export function needsBashTokens(command: string): boolean {
	command = command.trimStart();
	return (
		/^(?:timeout|time|nice|nohup|stdbuf|command|builtin|noglob|xargs|watch|setsid|ionice|flock|find)\b/.test(command) ||
		/^\w+=/.test(command)
	);
}
