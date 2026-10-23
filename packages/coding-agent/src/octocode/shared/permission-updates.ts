import { isRecord } from "./util.ts";

export type SourcePermissionDestination = "session" | "localSettings" | "projectSettings" | "userSettings";
type SourcePermissionBehavior = "allow" | "deny" | "ask";
interface SourcePermissionRule {
	toolName: string;
	ruleContent?: string;
}
export type SourcePermissionUpdate =
	| {
			type: "addRules" | "replaceRules" | "removeRules";
			rules: SourcePermissionRule[];
			behavior: SourcePermissionBehavior;
			destination: SourcePermissionDestination;
	  }
	| {
			type: "setMode";
			mode: "default" | "manual" | "auto" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "plan";
			destination: SourcePermissionDestination;
	  }
	| {
			type: "addDirectories" | "removeDirectories";
			directories: string[];
			destination: SourcePermissionDestination;
	  };

export function parsePermissionUpdates(value: unknown): SourcePermissionUpdate[] {
	if (!Array.isArray(value) || value.length > 4096) throw new Error("updatedPermissions must be a bounded array");
	return value.map((entry) => {
		if (
			!isRecord(entry) ||
			!["session", "localSettings", "projectSettings", "userSettings"].includes(String(entry.destination))
		)
			throw new Error("Invalid permission update destination");
		const destination = entry.destination as SourcePermissionDestination;
		if (["addRules", "replaceRules", "removeRules"].includes(String(entry.type))) {
			if (
				!["allow", "deny", "ask"].includes(String(entry.behavior)) ||
				!Array.isArray(entry.rules) ||
				entry.rules.length > 4096
			)
				throw new Error("Invalid permission rule update");
			const rules = entry.rules.map((rule) => {
				if (
					!isRecord(rule) ||
					typeof rule.toolName !== "string" ||
					!/^([^()\s]+)$/.test(rule.toolName) ||
					rule.toolName.length > 8192 ||
					(rule.ruleContent !== undefined && (typeof rule.ruleContent !== "string" || rule.ruleContent.length > 8192))
				)
					throw new Error("Invalid permission update rule");
				return {
					toolName: rule.toolName,
					...(rule.ruleContent !== undefined ? { ruleContent: rule.ruleContent as string } : {}),
				};
			});
			return {
				type: entry.type as "addRules" | "replaceRules" | "removeRules",
				rules,
				behavior: entry.behavior as SourcePermissionBehavior,
				destination,
			};
		}
		if (entry.type === "setMode") {
			if (
				!["default", "manual", "auto", "acceptEdits", "dontAsk", "bypassPermissions", "plan"].includes(
					String(entry.mode),
				)
			)
				throw new Error("Invalid source permission mode");
			return {
				type: "setMode",
				mode: entry.mode as Extract<SourcePermissionUpdate, { type: "setMode" }>["mode"],
				destination,
			};
		}
		if (entry.type === "addDirectories" || entry.type === "removeDirectories") {
			if (
				!Array.isArray(entry.directories) ||
				entry.directories.length > 4096 ||
				entry.directories.some((dir) => typeof dir !== "string" || !dir || dir.length > 8192)
			)
				throw new Error("Invalid permission directories");
			return {
				type: entry.type,
				directories: [...entry.directories] as string[],
				destination,
			};
		}
		throw new Error("Invalid permission update type");
	});
}

export type SourcePermissionMode = "default" | "acceptEdits" | "dontAsk";
export type SourceRuleArrays = Record<SourcePermissionBehavior, string[]> & {
	defaultMode?: SourcePermissionMode;
	additionalDirectories?: string[];
};
export function applyRuleUpdates(
	current: SourceRuleArrays,
	updates: readonly SourcePermissionUpdate[],
	destination: SourcePermissionDestination,
): SourceRuleArrays {
	const next: SourceRuleArrays = {
		...current,
		...(current.additionalDirectories ? { additionalDirectories: [...current.additionalDirectories] } : {}),
		allow: [...current.allow],
		deny: [...current.deny],
		ask: [...current.ask],
	};
	for (const update of updates) {
		if (update.destination !== destination)
			throw new Error(`Unsupported permission update ${update.type} at ${update.destination}; call not executed`);
		if (update.type === "setMode") {
			if (!["default", "manual", "acceptEdits", "dontAsk"].includes(update.mode))
				throw new Error(`Unsupported source permission mode ${update.mode}; call not executed`);
			next.defaultMode = update.mode === "manual" ? "default" : (update.mode as SourcePermissionMode);
			continue;
		}
		if ("directories" in update) {
			const { directories } = update;
			const previous = next.additionalDirectories ?? [];
			next.additionalDirectories =
				update.type === "addDirectories"
					? [...new Set([...previous, ...directories])]
					: previous.filter((directory) => !directories.includes(directory));
			if (next.additionalDirectories.length > 4096) throw new Error("Permission directory update exceeds the limit");
			continue;
		}
		const rules = update.rules.map((rule) =>
			rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`,
		);
		if (update.type === "replaceRules") next[update.behavior] = [...new Set(rules)];
		else if (update.type === "addRules") next[update.behavior] = [...new Set([...next[update.behavior], ...rules])];
		else next[update.behavior] = next[update.behavior].filter((rule) => !rules.includes(rule));
		if (next[update.behavior].length > 4096) throw new Error("Permission rule update exceeds the rule limit");
	}
	return next;
}

export const applySessionRuleUpdates = (
	current: SourceRuleArrays,
	updates: readonly SourcePermissionUpdate[],
): SourceRuleArrays => applyRuleUpdates(current, updates, "session");

export type PermissionUpdateCommit = (
	signal: AbortSignal,
	publish: (change: () => void) => void,
) => Promise<void> | void;
