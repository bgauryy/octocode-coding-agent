import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getKeybindings, setKeybindings, visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { resolveReadPathAsync } from "../../src/core/tools/path-utils.ts";
import { showBoard } from "../../src/octocode/backlog/board.ts";
import { CHIPS, chipText, shortChip } from "../../src/octocode/permission/mode.ts";
import { readPaths, resolveToolPath } from "../../src/octocode/shared/home.ts";
import { appKey, expandKey } from "../../src/octocode/shared/render/text.ts";
import { hintText } from "../../src/octocode/ui/editor.ts";
import { fakeCtx, theme } from "./fake-pi.ts";

describe("native cleanup regressions", () => {
	it("paints the permission chip by risk: manual muted, workspace accent, full warning (never error)", () => {
		expect(Object.fromEntries(Object.entries(CHIPS).map(([mode, chip]) => [mode, chip.color]))).toEqual({
			manual: "muted",
			workspace: "accent",
			full: "warning",
		});
	});

	it("uses rebound and disabled keys in editor, permission and tool hints", () => {
		const previous = getKeybindings();
		const bindings = new KeybindingsManager({
			"app.permission.cycle": "ctrl+y",
			"app.tools.expand": "ctrl+e",
			"app.thinking.toggle": [],
		});
		setKeybindings(bindings);
		try {
			expect(hintText(200, bindings)).toContain("ctrl+y permission");
			expect(chipText("workspace")).toBe("permission: workspace · Ctrl+Y");
			expect(shortChip(chipText("full", { actions: 2, warnings: 1 }))).toBe("⏵⏵ full · 2 actions · 1 ⚠");
			expect(shortChip(chipText("manual"))).toBe("⏸ manual");
			expect(expandKey()).toBe("ctrl+e");
			expect(appKey("app.thinking.toggle")).toBe("unbound");
			bindings.setUserBindings({ "app.permission.cycle": [] });
			expect(chipText("full")).toContain("Unbound");
			expect(hintText(200, bindings)).not.toContain("shift+tab");
		} finally {
			setKeybindings(previous);
		}
	});

	it("renders backlog bindings and redraws at narrow widths and new heights", async () => {
		const bindings = new KeybindingsManager({ "app.backlog.add": "n", "app.backlog.export": [] });
		const terminal = { rows: 40, columns: 240 };
		const ctx = fakeCtx({
			cwd: ".",
			ui: {
				custom: (factory) =>
					new Promise((resolve) => {
						const board = factory({ requestRender: () => undefined, terminal }, theme, bindings, resolve) as {
							render(width: number): string[];
							handleInput(data: string): void;
						};
						const wide = board.render(240);
						expect(wide.join("\n")).toContain("N add");
						expect(wide.join("\n")).toContain("Unbound export");
						expect(wide.join("\n")).not.toContain("a add");
						for (const width of [12, 1, 80]) {
							const narrow = board.render(width);
							expect(narrow.every((line) => visibleWidth(line) <= width)).toBe(true);
						}
						const tall = board.render(80);
						expect(tall.join("\n")).toContain("Escape/Ctrl+C/Q close");
						expect(tall.join("\n")).toContain("Unbound export");
						terminal.rows = 14;
						expect(board.render(80).length).toBeLessThan(tall.length);
						board.handleInput("n");
					}),
			},
		});
		await expect(
			showBoard(ctx, { title: "Backlog", self: "test", load: () => [], move: () => undefined }),
		).resolves.toEqual({ action: "add" });
	});

	it("tracks the exact filename opened by native reads, including screenshot variants", async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-path-parity-"));
		try {
			const cases = [
				["@file\u00a0name.txt", "file name.txt"],
				["Screenshot 10.00 AM.png", "Screenshot 10.00\u202fAM.png"],
				["Capture d'ecran.txt", "Capture d’ecran.txt"],
				["café.txt", "cafe\u0301.txt"],
			];
			for (const [input, filename] of cases) {
				fs.writeFileSync(path.join(cwd, filename), "selected");
				const tracked = readPaths("read", { path: input }, cwd)[0];
				expect(tracked).toBe(await resolveReadPathAsync(input, cwd));
				expect(fs.readFileSync(tracked, "utf8")).toBe("selected");
			}
			const url = pathToFileURL(path.join(cwd, "file name.txt")).href;
			expect(resolveToolPath(cwd, url)).toBe(path.join(cwd, "file name.txt"));
			expect(readPaths("read", { path: "missing" }, cwd)).toEqual([path.join(cwd, "missing")]);
			expect(readPaths("write", { path: "missing" }, cwd)).toEqual([]);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
