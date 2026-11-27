import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import type { ConfigKind } from "../../src/core/discovery/types.ts";
import { tmp } from "./helpers.ts";

function write(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

const skill = (dir: string, name: string) =>
	write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody\n`);

/** A repository at `repo` whose trust grant covers only `packages/a`. */
function repo() {
	const home = tmp();
	const agentDir = tmp();
	const repoRoot = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(repoRoot, ".git"));
	const cwd = path.join(repoRoot, "packages", "a");
	fs.mkdirSync(cwd, { recursive: true });
	const loaded = (kind: ConfigKind, contextRoot?: string) =>
		configDiscovery
			.discover(
				kind,
				discoveryInput({
					cwd,
					agentDir,
					home,
					projectTrusted: true,
					piRoots: [],
					env: {},
					toggles: { "harness:claude": true, "harness:codex": true, "harness:cursor": true, "harness:agents": true },
					...(contextRoot ? { contextRoot } : {}),
				}),
			)
			.filter((item) => item.loaded)
			.map((item) => item.provenance.path);
	return { repoRoot, cwd, loaded };
}

describe("project hooks and skills stay inside the trust grant's folder", () => {
	it("reads repository-root hook files only when the grant covers the repository root", () => {
		const r = repo();
		for (const file of [".octocode/hooks.json", ".claude/settings.json", ".codex/hooks.json"])
			write(path.join(r.repoRoot, file), "{}");
		const roots = (contextRoot?: string) => r.loaded("hook", contextRoot).filter((file) => file.startsWith(r.repoRoot));
		expect(roots(r.cwd)).toEqual([]);
		expect(roots(r.repoRoot).length).toBeGreaterThanOrEqual(3);
		expect(roots().length).toBeGreaterThanOrEqual(3);
	});

	it("reads skills only from folders between the trust root and the working folder", () => {
		const r = repo();
		const outer = r.repoRoot;
		for (const dir of [".octocode/skills", ".claude/skills", ".cursor/skills", ".agents/skills"])
			skill(path.join(outer, dir), "outer");
		skill(path.join(r.cwd, ".claude", "skills"), "inner");
		const names = (contextRoot?: string) =>
			r.loaded("skill", contextRoot).filter((file) => file.includes(path.join(r.repoRoot, "")));
		expect(names(r.cwd).some((file) => file.includes(`${path.sep}outer${path.sep}`))).toBe(false);
		expect(names(r.cwd).some((file) => file.includes(`${path.sep}inner${path.sep}`))).toBe(true);
		expect(names(r.repoRoot).some((file) => file.includes(`${path.sep}outer${path.sep}`))).toBe(true);
	});
});
