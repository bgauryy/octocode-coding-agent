import fs from "node:fs";
import path from "node:path";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Config from "../../src/config.ts";
import { getNativeSkillsDir } from "../../src/config.ts";
import { claudeConfigDir } from "../../src/utils/host-config.ts";
import { collectContextView } from "../../src/core/discovery/context-snapshot.ts";
import { buildContextView, sourceInfoLabel, sourceSummary } from "../../src/core/discovery/context-view.ts";
import { formatContextText } from "../../src/core/discovery/context-text.ts";
import { resetPiNoticeForTests, takePiNotice } from "../../src/core/discovery/pi-notice.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { warningsBesideListing } from "../../src/core/resource-loader/feature-loading.ts";
import { startupWarnings, viewRows } from "../../src/modes/interactive/interactive-mode/discovery-rows.ts";
import { LoadedRow, loadedColumns } from "../../src/modes/interactive/interactive-mode/loaded-row.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { type Sandbox, createSandbox, skillFile, write } from "../discovery/fixtures.ts";
import { createTestSession } from "../helpers/session.ts";

// The fixture counts its own skills; the Octocode skill collection installed on this machine stays out, as
// `OCTOCODE_MCP=0` keeps the default server out.
vi.mock("../../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	getOctocodeSkillsDir: () => undefined,
}));

let box: Sandbox;

beforeAll(() => initTheme("dark", false));
beforeEach(() => {
	box = createSandbox();
	resetPiNoticeForTests();
	vi.stubEnv("OCTOCODE_OFFLINE", "1");
	vi.stubEnv("OCTOCODE_MCP", "0");
});
afterEach(() => box.cleanup());

/** Octocode and Pi items that shadow each other, an ignored Pi extension and an untrusted project folder. */
function populate(): void {
	write(path.join(box.agentDir, "AGENTS.md"), "octocode instructions\n");
	skillFile(path.join(box.agentDir, "skills"), "shared");
	skillFile(path.join(box.agentDir, "skills"), "alpha");
	write(path.join(box.agentDir, "prompts", "review.md"), "Review\n");
	write(path.join(box.piAgentDir, "AGENTS.md"), "pi instructions\n");
	skillFile(path.join(box.piAgentDir, "skills"), "shared");
	skillFile(path.join(box.piAgentDir, "skills"), "pi-only");
	write(path.join(box.piAgentDir, "extensions", "legacy.ts"), "export default () => {};\n");
	skillFile(path.join(box.cwd, ".octocode", "skills"), "project-skill");
}

function view(projectTrusted: boolean) {
	populate();
	return collectContextView({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted });
}

/** The startup rows of `view` as the terminal draws them. */
function render(projectTrusted: boolean, width: number, expanded: boolean): string[] {
	const specs = viewRows(view(projectTrusted), (file) => file.replace(box.home, "~")).map((row) => row.spec);
	const columns = () => loadedColumns(specs);
	return specs.flatMap((spec) => new LoadedRow(spec, columns, expanded).render(width));
}

const plain = (lines: string[]) => lines.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));

/** The startup warning lines of `view`, one per problem (no skill or keybinding problems in these fixtures). */
const warningTexts = (projectTrusted: boolean) =>
	startupWarnings(view(projectTrusted), [], []).warnings.map((warning) => warning.text);

describe("startup context rows", () => {
	it("fits every line at 100 and 60 columns, collapsed and expanded", () => {
		for (const width of [100, 60])
			for (const expanded of [false, true])
				for (const line of render(false, width, expanded)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("lists each kind with its count and sources at 100 columns, with the problems in the tail", () => {
		const lines = plain(render(false, 100, false));
		expect(lines.find((line) => /^Context\s+1\s+octocode global AGENTS\.md/.test(line))).toBeDefined();
		expect(lines.find((line) => /^Skills\s+3\s+octocode global 2 \u00b7 pi global 1/.test(line))).toMatch(
			/1 shadowed.*1 not trusted/,
		);
		expect(lines.find((line) => /^Prompts\s+1\s+octocode global review/.test(line))).toBeDefined();
		expect(
			lines.find((line) =>
				/^Not loaded\s+1\s+legacy\.ts \(pi global\) \u00b7 convert to hooks\.json or a plugin/.test(line),
			),
		).toBeDefined();
		// The problems are startup warning lines of their own, not a Warnings row.
		expect(lines.some((line) => line.startsWith("Warnings"))).toBe(false);
	});

	it("drops the tail first at 60 columns; the problems stay in the startup warning lines", () => {
		const lines = plain(render(false, 60, false));
		const skills = lines.find((line) => line.startsWith("Skills")) ?? "";
		expect(skills).toMatch(/^Skills\s+3\s+octocode global 2/);
		expect(skills).not.toContain("shadowed");
		expect(warningTexts(false).join("\n")).toMatch(/duplicate skill skipped/);
	});

	it("expanded, names every item with its source and why a copy does not apply", () => {
		const text = plain(render(false, 100, true)).join("\n");
		expect(text).toMatch(/octocode global\n\s+alpha\s+.*skills\/alpha\/SKILL\.md/);
		expect(text).toContain("shadowed by octocode global");
		expect(text).toContain("AGENTS.md");
		expect(text).toMatch(/legacy\.ts\s+.*\(Pi extension, not loaded\)/);
		expect(text).toMatch(/project-skill[\s\S]*?\(folder not\s+trusted\)/);
		expect(warningTexts(false)).toContain("1 project item not loaded: folder not trusted; run /trust");
	});

	it("loads a trusted project's items and drops the untrusted note", () => {
		const text = plain(render(true, 100, true)).join("\n");
		expect(text).toMatch(/octocode project\n\s+project-skill/);
		expect(text).not.toContain("folder not trusted");
	});
});

describe("one-time Pi notice", () => {
	it("names what was found on the first start and is silent on the second", () => {
		const found = view(false);
		const first = takePiNotice(found, box.agentDir);
		expect(first).toMatch(/^Found Pi configuration: .*\d skills?.*\/harness config/);
		// The same process draws the screen again (a reload): the line stays.
		expect(takePiNotice(found, box.agentDir)).toBe(first);
		// A new process: the record on disk says it was shown.
		resetPiNoticeForTests();
		expect(takePiNotice(found, box.agentDir)).toBeUndefined();
	});

	it("shows nothing and records nothing when no Pi item exists", () => {
		write(path.join(box.agentDir, "AGENTS.md"), "octocode only\n");
		const found = collectContextView({ cwd: box.cwd, agentDir: box.agentDir, projectTrusted: true });
		expect(takePiNotice(found, box.agentDir)).toBeUndefined();
		expect(fs.existsSync(path.join(box.agentDir, "pi-notice.json"))).toBe(false);
	});
});

describe("/harness config", () => {
	it("prints the same snapshot as text through the command entry point, with an Octocode and a Pi home", async () => {
		populate();
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({ cwd: box.cwd, agentDir: box.agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createTestSession({
			cwd: box.cwd,
			agentDir: box.agentDir,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(box.cwd),
		});
		const written: string[] = [];
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		try {
			await session.prompt("/harness config");
		} finally {
			stderr.mockRestore();
			await session.dispose();
		}
		const text = written.join("");
		expect(text).toContain("Loaded context and where each item came from");
		expect(text).toMatch(/octocode global: AGENTS\.md\n {4}~\/\.octocode\/octocodecode\/AGENTS\.md/);
		expect(text).toMatch(/pi global: AGENTS\.md \(shadowed by octocode global\)\n {4}~\/\.pi\/agent\/AGENTS\.md/);
		expect(text).toMatch(/pi global: shared \(shadowed by octocode global\)/);
		expect(text).toMatch(/pi global: pi-only/);
		expect(text).toMatch(
			/pi global: legacy\.ts \(Pi extension, not loaded\)\n\s+~\/\.pi\/agent\/extensions\/legacy\.ts/,
		);
		expect(text).toContain("convert to hooks.json or a plugin");
	});
});

describe("one message per problem", () => {
	it("says a Pi extension is not loaded once: in the Not loaded row, not in a warning or the notice", () => {
		const lines = plain(render(false, 100, false));
		expect(lines.filter((line) => line.includes("legacy.ts"))).toHaveLength(1);
		const warnings = startupWarnings(view(false), [], []).warnings;
		expect(warnings.map((warning) => warning.text).join("\n")).not.toMatch(/Pi code|not loaded: convert|legacy/);
		// Expanded, the file is listed under Not loaded, not again in a warning's details.
		expect(warnings.flatMap((warning) => warning.details).join("\n")).not.toContain("legacy.ts");
		expect(takePiNotice(view(false), box.agentDir)).not.toMatch(/extension/);
	});

	it("has no Pi notice when the only Pi item is code that is not loaded (its row says so)", () => {
		write(path.join(box.piAgentDir, "extensions", "legacy.ts"), "export default () => {};\n");
		const found = collectContextView({
			cwd: box.cwd,
			agentDir: box.agentDir,
			projectTrusted: true,
		});
		expect(takePiNotice(found, box.agentDir)).toBeUndefined();
	});

	it("hands the loader's warning for listed code a mark, so screens that list it can skip it", async () => {
		populate();
		const loader = new DefaultResourceLoader({
			cwd: box.cwd,
			agentDir: box.agentDir,
			settingsManager: SettingsManager.inMemory(),
		});
		await loader.reload();
		const warnings = loader.getExtensions().warnings ?? [];
		const legacy = warnings.find((warning) => warning.path.endsWith("legacy.ts"));
		expect(legacy?.warning).toContain("Pi extension, not loaded");
		expect(legacy?.listedInContext).toBe(true);
		expect(warningsBesideListing(warnings)).toEqual(warnings.filter((warning) => !warning.listedInContext));
		expect(warningsBesideListing(warnings).map((warning) => warning.path)).not.toContain(legacy?.path);
	});
});

describe("startup warning lines", () => {
	it("are one line per problem, saying what to do, and the rows hold no Warnings row", () => {
		const texts = warningTexts(false);
		expect(texts).toEqual([
			expect.stringMatching(
				/^1 duplicate context file skipped: a copy with the same name loads instead \(ctrl\+o lists them\)$/,
			),
			expect.stringMatching(
				/^1 duplicate skill skipped: a skill with the same name loads from .+ \(ctrl\+o lists them\)$/,
			),
			"1 project item not loaded: folder not trusted; run /trust",
		]);
		for (const text of texts) expect(text).not.toContain("\n");
		for (const width of [60, 100])
			expect(plain(render(false, width, false)).some((line) => line.startsWith("Warnings"))).toBe(false);
	});
});

describe("source labels", () => {
	it("names a path from settings or a flag, never 'path'", () => {
		expect(sourceInfoLabel({ source: "cli", scope: "temporary" })).toBe("command line");
		expect(sourceInfoLabel({ source: "local", scope: "temporary" })).toBe("settings path");
		// A built-in extension has the `builtin` source.
		expect(sourceInfoLabel({ source: "builtin", scope: "user" })).toBe("builtin");
		expect(sourceInfoLabel({ source: "builtin", scope: "user", path: "<builtin:llama.cpp>" })).toBe("builtin");
		expect(sourceInfoLabel({ source: "local", scope: "user" })).toBe("octocode global");
		expect(sourceInfoLabel({ source: "npm:kit", scope: "project" })).toBe("package npm:kit");
	});

	it("tells Octocode's core skills and external skill folders apart", () => {
		const file = (dir: string) => path.join(dir, "x", "SKILL.md");
		expect(sourceInfoLabel({ source: "local", scope: "temporary", path: file(getNativeSkillsDir()) })).toBe("core");
		expect(
			sourceInfoLabel({
				source: "extension:inline:octocode",
				scope: "temporary",
				path: file(path.join(claudeConfigDir(), "skills")),
			}),
		).toBe("claude global");
	});

	it("counts servers per source instead of naming them", () => {
		const server = { enabled: true, state: "connected", source: "built-in", scope: "default" };
		const mcp = buildContextView({
			discovery: new Map(),
			mcp: [
				{ ...server, name: "browser" },
				{ ...server, name: "octocode", enabled: false },
			],
		}).groups[0];
		expect(sourceSummary(mcp, { counted: true })).toBe("builtin 2");
	});

	it("shows Pi and Octocode settings as layers, never shadowed", () => {
		write(path.join(box.agentDir, "settings.json"), "{}");
		write(path.join(box.piAgentDir, "settings.json"), "{}");
		write(path.join(box.cwd, ".octocode", "settings.json"), "{}");
		const found = collectContextView({
			cwd: box.cwd,
			agentDir: box.agentDir,
			projectTrusted: true,
		});
		const specs = viewRows(found, (file) => file).map((row) => row.spec);
		const columns = () => loadedColumns(specs);
		const lines = plain(specs.flatMap((spec) => new LoadedRow(spec, columns, false).render(120)));
		const row = lines.find((line) => line.startsWith("Settings")) ?? "";
		expect(row).toMatch(/octocode global settings\.json/);
		expect(row).toMatch(/pi global settings\.json/);
		expect(row).toMatch(/octocode project settings\.json/);
		expect(lines.join("\n")).not.toContain("shadowed");
	});

	it("lists a configured plugin with its manifest name and source", () => {
		const dir = path.join(box.home, "plugins", "review-kit");
		write(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "review-kit" }));
		const found = collectContextView({
			cwd: box.cwd,
			agentDir: box.agentDir,
			projectTrusted: true,
			settings: { plugins: [{ path: dir, protocol: "claude" }] },
		});
		const plugins = found.groups.find((group) => group.id === "plugin");
		expect(plugins?.entries.map((entry) => `${entry.name}|${entry.source}`)).toEqual(["review-kit|plugin"]);
	});
});

describe("startup hook rows", () => {
	it("list only files that define a hook, not settings files that merely exist", () => {
		write(path.join(box.home, ".claude", "settings.json"), '{"theme":"dark"}');
		write(path.join(box.home, ".codex", "config.toml"), 'model = "x"\n');
		write(path.join(box.cwd, ".claude", "settings.json"), '{"hooks":{}}');
		const found = () =>
			collectContextView({
				cwd: box.cwd,
				agentDir: box.agentDir,
				projectTrusted: true,
			}).groups.find((group) => group.id === "hook");
		expect(found()?.entries ?? []).toEqual([]);
		write(
			path.join(box.home, ".claude", "settings.json"),
			JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
		);
		expect(found()?.entries.map((entry) => path.basename(entry.path ?? ""))).toEqual(["settings.json"]);
	});
});

describe("/config text at a narrow width", () => {
	it("puts each path on its own indented line and shortens it from the left, never mid-word", () => {
		const found = view(false);
		const long = path.join(box.home, "a-very-long-folder-name", "another-long-folder", "deep", "SKILL.md");
		const text = formatContextText(
			{
				...found,
				groups: found.groups.map((group) => ({
					...group,
					entries: group.entries.map((entry, index) => (index === 0 ? { ...entry, path: long } : entry)),
				})),
			},
			box.home,
			60,
		);
		// Prose wraps at spaces on a screen; a path has none, so it must fit whole.
		for (const line of text.split("\n"))
			if (line.startsWith("    ") && !line.trim().includes(" ")) expect(line.length).toBeLessThanOrEqual(60);
		const lines = text.split("\n");
		const at = lines.findIndex((line) => /^ {2}octocode global: /.test(line));
		expect(lines[at]).not.toContain("~");
		expect(lines[at + 1]).toMatch(/^ {4}\u2026?[^ ]*$/);
		const shortened = lines.find((line) => line.startsWith("    \u2026"));
		expect(shortened).toBeDefined();
		expect(shortened).toMatch(/SKILL\.md$/);
		// Without a width nothing is shortened.
		expect(formatContextText(found, box.home)).not.toContain("\u2026");
	});
});
