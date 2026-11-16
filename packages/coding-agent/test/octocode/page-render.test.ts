import fs from "node:fs";
import path from "node:path";
import { setKeybindings, type TUI } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { HarnessPicker } from "../../src/octocode/harness/picker.ts";
import type { InventoryItem } from "../../src/octocode/harness/inventory.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { initTheme, theme } from "../../src/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => closeSharedAgentDb());

const text = (lines: string[]) => stripAnsi(lines.join("\n"));

describe("/harness page", () => {
	const skill = (label: string, detail: string, on = true): InventoryItem => ({
		id: `skill:${label}`,
		name: label,
		host: "skills",
		kind: "skill",
		depth: 0,
		label,
		on,
		detail,
	});

	it("lists each section with switch state, detail, scope paths and key hints", () => {
		const picker = new HarnessPicker(
			{
				items: [
					skill("review", "Octocode (collection) · skills/review/SKILL.md"),
					skill("review-copy", "not loaded: Octocode (collection) wins · Pi (global) · ~/.pi/agent/skills/x"),
					skill("off-skill", "Project · .agents/skills/off", false),
				],
				apply: () => "ok",
				paths: { global: "~/settings.json", project: ".octocode/settings.json" },
				section: "skills",
				height: 30,
				done: () => {},
				requestRender: () => {},
			},
			theme,
			new KeybindingsManager(),
		);
		const out = text(picker.render(100));
		expect(out).toContain("Skills");
		expect(out).toMatch(/\[x\]\s+review/);
		expect(out).toMatch(/\[ \]\s+off-skill/);
		expect(out).toContain("~/settings.json");
		expect(out).toContain("type to filter");
		expect(out).toMatch(/review-copy\s+not loaded: Octocode \(collection\) wins/);
	});
});

describe("/backlog item page", () => {
	it("renders the item's title, state, priority and its action rows", async () => {
		const cwd = fs.realpathSync(tmp());
		const env = { ...process.env, OCTOCODE_AGENT_DB: path.join(cwd, "agent.db") };
		const fake = fakeHost();
		const commands = new Subcommands();
		registerBacklog(fake.api, { commands, isSubagent: false, env });
		const store = new BacklogStore(() => sharedAgentDb(env), registeredWorkspace(cwd, sharedAgentDb(env)).id);
		store.add({
			goal: "Expected result",
			why: "Required work",
			createdBy: "user",
			title: "Fix the thing",
			state: "todo",
		});
		let page = "";
		const ctx = fakeCtx({
			cwd,
			mode: "tui",
			ui: {
				custom: async (factory: (...args: unknown[]) => { render(width: number): string[] }) => {
					const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
					page = text(factory(tui, theme, new KeybindingsManager(), () => {}).render(100));
					return undefined;
				},
			},
		});
		await commands.get("backlog")!.handler("B1", ctx);
		expect(page).toContain("B1 Fix the thing");
		expect(page).toContain("State");
		expect(page).toContain("todo");
		expect(page).toContain("Priority");
		for (const action of ["Do it now", "Move to…", "Show notes and changes", "Close"]) expect(page).toContain(action);
	});
});
