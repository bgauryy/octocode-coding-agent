import "../../src/octocode/mcp-host/render-install.ts";
import { type McpServerListing, renderMcpsSection } from "../../../mcp/src/section.ts";
import {
	getCurrentSystemPrompt,
	getSystemMessageText,
	renderSystemMessageUpdate,
	type SystemMessage,
} from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import {
	buildSystemPromptSections,
	currentEnvironment,
	diffSystemPromptSections,
} from "../../src/core/system-prompt.ts";
import {
	NON_BASE_SECTIONS,
	sectionFamilyText,
	systemPromptSectionSpec,
	VOLATILE_SECTIONS,
} from "../../src/core/system-prompt-spec.ts";

const server = (name: string, contract: string): McpServerListing => ({
	entry: { name, source: "default", config: { command: "test" } },
	state: "connected",
	contract,
	declared: true,
});

/** A long research server, like the default one, and a small one that connects mid-session. */
const RESEARCH = server(
	"octocode",
	Array.from({ length: 40 }, (_, i) => `Research rule ${i}: search, then read.`).join("\n"),
);
const DOCS = server("docs", "Search the product documentation.");

const ROOT_FILE = { path: "/repo/AGENTS.md", content: "# Repo\nRun the tests." };
const PACKAGE_FILE = { path: "/repo/pkg/AGENTS.md", content: "# Package\nKeep files short." };

const sections = (
	options: { servers?: McpServerListing[]; files?: Array<{ path: string; content: string }>; now?: Date } = {},
) =>
	buildSystemPromptSections({
		cwd: "/repo",
		baseSections: { mcps: renderMcpsSection(options.servers ?? [RESEARCH], { declared: true }) ?? "" },
		contextFiles: options.files ?? [ROOT_FILE, PACKAGE_FILE],
		environment: currentEnvironment(options.now ?? new Date(2026, 10, 17, 23, 59), { SHELL: "/bin/zsh" }),
	});

const message = (patch: Record<string, string | null>, timestamp: number): SystemMessage => ({
	role: "system",
	content: "",
	sections: patch,
	timestamp,
});

describe("per-server, per-file and per-field section deltas", () => {
	it("an MCP connect sends only the new server's block, in the base tier", () => {
		const before = sections();
		const after = sections({ servers: [RESEARCH, DOCS] });
		const patch = diffSystemPromptSections(before, after)!;
		expect(Object.keys(patch)).toEqual(["mcps:docs"]);
		expect(patch["mcps:docs"]).toContain('<mcp name="docs"');
		expect(patch["mcps:docs"]).toContain("Search the product documentation.");
		expect(patch["mcps:docs"]).not.toContain("Research rule");
		expect(systemPromptSectionSpec("mcps:docs")?.tier).toBe("base");
		expect(NON_BASE_SECTIONS.has("mcps:docs")).toBe(false);
		// Replaying the delta gives the model every server's block, the earlier ones byte for byte.
		const replayed = getCurrentSystemPrompt([message(before, 0), message(patch, 1)]);
		for (const text of Object.values(before)) expect(replayed).toContain(text);
		expect(replayed).toContain(patch["mcps:docs"]!);
		expect(sectionFamilyText(after, "mcps")).toContain('<mcp name="octocode"');
		expect(sectionFamilyText(after, "mcps")).toContain('<mcp name="docs"');
		// One server delta is a fraction of the whole family.
		expect(renderSystemMessageUpdate(message(patch, 1)).length).toBeLessThan(
			sectionFamilyText(after, "mcps").length / 4,
		);
	});

	it("after compaction the mcps re-send against the session's first prompt covers only the changed servers", () => {
		const first = sections({ servers: [RESEARCH, server("docs", "Old docs instructions.")] });
		const now = sections({ servers: [RESEARCH, DOCS] });
		expect(Object.keys(diffSystemPromptSections(first, now)!)).toEqual(["mcps:docs"]);
		const disconnected = sections({ servers: [RESEARCH] });
		expect(diffSystemPromptSections(now, disconnected)).toEqual({ "mcps:docs": null });
	});

	it("an instruction-file edit re-sends only that file, in the session tier", () => {
		const before = sections();
		const edited = { ...PACKAGE_FILE, content: "# Package\nKeep files under 400 lines." };
		const patch = diffSystemPromptSections(before, sections({ files: [ROOT_FILE, edited] }))!;
		const name = "project_context:pkg/AGENTS.md";
		expect(Object.keys(patch)).toEqual([name]);
		expect(patch[name]).toContain("Keep files under 400 lines.");
		expect(patch[name]).not.toContain("Run the tests.");
		expect(patch[name]).toMatch(/^<project_instructions path="pkg\/AGENTS.md">/);
		expect(systemPromptSectionSpec(name)?.tier).toBe("session");
		expect(NON_BASE_SECTIONS.has(name)).toBe(true);
		expect(VOLATILE_SECTIONS.has(name)).toBe(false);
		// A deeper file read adds one section, the others stay.
		const deeper = { path: "/repo/pkg/sub/AGENTS.md", content: "Sub rules." };
		const added = diffSystemPromptSections(before, sections({ files: [ROOT_FILE, PACKAGE_FILE, deeper] }))!;
		expect(Object.keys(added)).toEqual(["project_context:pkg/sub/AGENTS.md"]);
	});

	it("a date change sends only the date field, in the volatile tier", () => {
		const before = sections();
		const patch = diffSystemPromptSections(before, sections({ now: new Date(2026, 10, 18, 0, 1) }))!;
		expect(Object.keys(patch)).toEqual(["environment:date"]);
		expect(patch["environment:date"]).toBe("Date: 2026-11-18");
		expect(systemPromptSectionSpec("environment:date")?.tier).toBe("volatile");
		expect(VOLATILE_SECTIONS.has("environment:date")).toBe(true);
		expect(sectionFamilyText(before, "environment")).toContain("Platform: ");
	});

	it("a no-op span keeps the head byte-identical and sends nothing", () => {
		const first = sections({ servers: [RESEARCH, DOCS] });
		const again = sections({ servers: [RESEARCH, DOCS] });
		expect(diffSystemPromptSections(first, again)).toBeUndefined();
		const head = message(first, 0);
		expect(getSystemMessageText(message(again, 0))).toBe(getSystemMessageText(head));
		expect(Object.keys(first)).toEqual(Object.keys(again));
	});
});
