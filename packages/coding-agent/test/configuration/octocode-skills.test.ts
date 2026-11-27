import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Sandbox, createSandbox, skillFile } from "../discovery/fixtures.ts";
import { configuration, globalSettingsFile, readJson } from "./helpers.ts";
import type * as Config from "../../src/config.ts";

const collection = vi.hoisted(() => ({ dir: undefined as string | undefined }));
vi.mock("../../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Config>()),
	getOctocodeSkillsDir: () => collection.dir,
}));

let sandbox: Sandbox;
beforeEach(() => {
	sandbox = createSandbox();
	collection.dir = join(sandbox.home, "octocode-skills");
	skillFile(collection.dir, "octocode-roast");
});
afterEach(() => sandbox.cleanup());

describe("the Octocode skill collection", () => {
	it("is listed and switched like any other skill", async () => {
		const catalog = configuration(sandbox);
		expect(await catalog.get("skill:octocode-roast")).toMatchObject({ kind: "skill", value: true });
		expect((await catalog.apply({ verb: "disable", id: "skill:octocode-roast" })).status).toBe("applied");
		expect(JSON.stringify(readJson(globalSettingsFile(sandbox))?.skills)).toContain("octocode-roast");
		expect(await configuration(sandbox).get("skill:octocode-roast")).toMatchObject({ value: false });
	});
});
