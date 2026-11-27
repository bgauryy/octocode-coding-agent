/**
 * The generated hook-event reference. Every row comes from the hook catalog
 * (`src/octocode/hooks/catalog.ts`); this file only decides how to present it.
 */
import {
	HOOK_CATALOG,
	HOOK_EVENTS,
	PROFILE_COMMAND_FIELDS,
	PROFILE_TIMEOUT_S,
	profileSupport,
	UPSTREAM_ONLY_EVENTS,
	type HookProtocol,
} from "../../src/octocode/hooks/catalog.ts";

const PROFILES: ReadonlyArray<{ protocol: HookProtocol; label: string; files: string }> = [
	{ protocol: "octocode", label: "Native", files: "`<Octocode home>/hooks.json`, `.octocode/hooks.json`" },
	{ protocol: "claude", label: "Claude", files: "Claude `settings.json` files and Claude plugins" },
	{ protocol: "codex", label: "Codex", files: "Codex `hooks.json`, `config.toml` and Codex or portable plugins" },
];

const code = (items: readonly string[]) => items.map((item) => `\`${item}\``).join(", ");

export const hookEventsIntro = [
	"This page lists every hook event Octocode implements and what each source profile accepts there. Each hook file runs under the profile of the host that defines its format; the profiles are:",
	PROFILES.map(({ label, files }) => `- **${label}**: ${files}.`).join("\n"),
	"See [Hooks](hooks.md) for discovery, trust, the input each event receives and the output it accepts.",
].join("\n\n");

/** One row per event: the handler types each profile accepts there, or a dash. */
export function hookEventTable(): string {
	const cell = (protocol: HookProtocol, event: string) => {
		const support = profileSupport(protocol, event);
		if (!support) return "—";
		const notes = [
			...(support.timeout !== undefined ? [`${support.timeout} s default`] : []),
			...(support.ignoresMatcher ? ["no matcher"] : []),
		];
		return `${code(["command", ...support.handlers])}${notes.length ? ` (${notes.join(", ")})` : ""}`;
	};
	const rows = HOOK_EVENTS.map(
		(event) =>
			`| \`${event}\` | ${PROFILES.map(({ protocol }) => cell(protocol, event)).join(" | ")} | ${HOOK_CATALOG[event].behavior} |`,
	);
	return [
		`| Event | ${PROFILES.map(({ label }) => label).join(" | ")} | Behavior |`,
		`|---|${PROFILES.map(() => "---").join("|")}|---|`,
		...rows,
	].join("\n");
}

export function hookInputTable(): string {
	const rows = HOOK_EVENTS.flatMap((event) => {
		const cells = (["claude", "codex"] as const).map((protocol) => {
			const support = profileSupport(protocol, event);
			return support ? code(support.input) || "none" : "—";
		});
		return cells.some((value) => value !== "—") ? [`| \`${event}\` | ${cells.join(" | ")} |`] : [];
	});
	return [
		"Native input carries no host metadata. Source profiles add these fields when the value is available; `agent` means `agent_id` and `agent_type` inside a subagent.",
		["| Event | Claude | Codex |", "|---|---|---|", ...rows].join("\n"),
	].join("\n\n");
}

export function hookFieldsList(): string {
	return [
		PROFILES.map(
			({ protocol, label }) =>
				`- **${label}** (default timeout ${PROFILE_TIMEOUT_S[protocol]} s): ${code(PROFILE_COMMAND_FIELDS[protocol])}.`,
		).join("\n"),
		"Other fields reject the handler with a diagnostic in `/harness hooks`. No timeout can exceed 600 seconds.",
	].join("\n\n");
}

export function hookUpstreamOnlyList(): string {
	return [
		"These events are documented by the upstream host but not implemented in Octocode yet. A hook file that declares one is loaded without it, and `/harness hooks` reports it as not implemented.",
		`- **Claude Code**: ${code(UPSTREAM_ONLY_EVENTS.claude)}.`,
		`- **Codex**: ${code(UPSTREAM_ONLY_EVENTS.codex)} (in Codex source, not yet in its documentation).`,
	].join("\n\n");
}
