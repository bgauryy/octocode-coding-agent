import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfiles } from "../../src/octocode/subagents/profiles.ts";

const dirs: string[] = [];
function tmp(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-profile-home-"));
	dirs.push(dir);
	return dir;
}
function profile(dir: string, name: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${name}\n---\nYou are ${name}.\n`);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("subagent profile directories", () => {
	it("reads the default home's agents when OCTOCODE_HOME is not set", () => {
		const home = tmp();
		profile(path.join(home, ".octocode", "octocodecode", "agents"), "from-home");
		expect(loadProfiles(tmp(), home, true, {}).has("from-home")).toBe(true);
	});

	it("reads only the OCTOCODE_HOME agents when it is set", () => {
		const home = tmp();
		const explicit = tmp();
		profile(path.join(home, ".octocode", "octocodecode", "agents"), "from-home");
		profile(path.join(explicit, "agents"), "from-explicit");
		const profiles = loadProfiles(tmp(), home, true, { OCTOCODE_HOME: explicit });
		expect(profiles.has("from-explicit")).toBe(true);
		expect(profiles.has("from-home")).toBe(false);
	});
});
