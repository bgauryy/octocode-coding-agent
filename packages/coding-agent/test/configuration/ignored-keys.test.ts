import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sandbox, createSandbox } from "../discovery/fixtures.ts";
import { configuration, globalSettingsFile, projectSettingsFile, readJson } from "./helpers.ts";

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
});
afterEach(() => sandbox.cleanup());

const write = (file: string, value: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
};

describe("unset of an ignored settings key", () => {
	it("removes an unknown root key and a nested one, keeping the rest", async () => {
		write(globalSettingsFile(sandbox), { theme: "dark", typo: 1, thinkingBudgets: { high: 1, xhigh: 2 } });
		const catalog = configuration(sandbox);
		expect(await catalog.apply({ verb: "unset", id: "typo" })).toMatchObject({ status: "applied" });
		expect(await catalog.apply({ verb: "unset", id: "thinkingBudgets.xhigh" })).toMatchObject({ status: "applied" });
		expect(readJson(globalSettingsFile(sandbox))).toEqual({ theme: "dark", thinkingBudgets: { high: 1 } });
	});

	it("removes a project file's ignored key only with the project scope", async () => {
		write(projectSettingsFile(sandbox), { compaction: { reserveTokens: 1 }, theme: "dark" });
		const catalog = configuration(sandbox);
		expect(await catalog.apply({ verb: "unset", id: "compaction" })).toMatchObject({ status: "refused" });
		expect(await catalog.apply({ verb: "unset", id: "compaction", scope: "project" })).toMatchObject({
			status: "applied",
		});
		expect(readJson(projectSettingsFile(sandbox))).toEqual({ theme: "dark" });
	});

	it("still refuses a key the file does not hold", async () => {
		write(globalSettingsFile(sandbox), { theme: "dark" });
		expect(await configuration(sandbox).apply({ verb: "unset", id: "nothere" })).toMatchObject({ status: "refused" });
	});
});
