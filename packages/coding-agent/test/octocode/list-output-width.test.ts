import { visibleWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runConfigWords } from "../../src/configuration/command.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { statusCommand } from "../../src/octocode/status-command.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { configuration } from "../configuration/helpers.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

beforeAll(() => initTheme("dark"));

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const rowsAt = (text: string, width: number) => text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width));

describe.each([60, 100])("long command lists at %i columns", (width) => {
	it("/status shows every skill name and the detail hint, in rows that fit", async () => {
		const fake = fakeHost();
		fake.flat.getCommands = () =>
			Array.from({ length: 40 }, (_, index) => ({ name: `skill-with-a-long-name-${index}`, source: "skill" }));
		const commands = new Subcommands();
		commands.add(
			"status",
			statusCommand(fake.api, { mode: "full" }, () => "Octocode 1.0"),
		);
		commands.register(fake.api);
		const ctx = Object.assign(fakeCtx({ cwd: ".", hasUI: true }), {
			sessionManager: SessionManager.inMemory(process.cwd()),
			getContextUsage: () => undefined,
		});
		await fake.commands.get("status")!.handler("", ctx);
		const text = ctx.ui.notes[0].message;
		expect(text).toContain("Skills (40)");
		expect(text).toContain("skill-with-a-long-name-39");
		expect(text).toContain("/harness list <skill name>");
		for (const row of rowsAt(text, width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});

	it("/configuration list stops at the row limit, names the filter and fits", async () => {
		const outcome = await runConfigWords(configuration(sandbox), ["list"], "/configuration", { listRows: 8 });
		const text = outcome.lines.join("\n");
		expect(text).toMatch(/… \d+ more entries\. Filter: \/configuration list <kind>\|<text>/);
		expect(outcome.lines.filter((line) => /^ {2}\S/.test(line))).toHaveLength(8);
		for (const row of rowsAt(text, width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	});
});
