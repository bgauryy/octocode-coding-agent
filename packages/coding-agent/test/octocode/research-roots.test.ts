import "../mcp-host.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigValueOrThrow } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import type { McpServerEntry } from "../../../mcp/src/config.ts";
import { presetEntries } from "../../../mcp/src/preset.ts";
import { octocodePreset } from "../../../mcp/src/presets/octocode/index.ts";
import { prepareOctocodeSkillLaunch } from "../../../mcp/src/presets/octocode/skill-paths.ts";
import { takeOctocodeWarnings } from "../../../mcp/src/presets/octocode/warnings.ts";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { userResearchRoots } from "../../src/octocode/mcp-host/research-roots.ts";
import { tmp } from "./helpers.ts";

const real = (dir: string): string => fs.realpathSync(dir);
const folder = (...parts: string[]): string => {
	const dir = path.join(...parts);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

/** An isolated user: a home folder, an Octocode home (`OCTOCODE_HOME`) and the folders a user might add. */
function user() {
	const home = real(tmp("roots-home-"));
	const octo = real(tmp("roots-octo-"));
	return {
		home,
		octo,
		env: { OCTOCODE_HOME: octo } as NodeJS.ProcessEnv,
		add: (name: string) => folder(real(tmp(`roots-${name}-`))),
		settings: (paths: unknown) =>
			fs.writeFileSync(path.join(octo, "settings.json"), JSON.stringify({ research: { allowedPaths: paths } })),
	};
}

describe("user research roots: sources", () => {
	it("reads settings, .env, .octocoderc and the process environment, stored by realpath, deduplicated and sorted", () => {
		const u = user();
		const [a, b, c, d] = [u.add("a"), u.add("b"), u.add("c"), u.add("d")];
		const link = path.join(real(tmp("roots-link-")), "to-d");
		fs.symlinkSync(d, link);
		u.settings([c, a]);
		fs.writeFileSync(path.join(u.octo, ".env"), `# comment\nexport ALLOWED_PATHS="${b}, ${a}"\nOTHER=1\n`);
		fs.writeFileSync(path.join(u.octo, ".octocoderc"), JSON.stringify({ local: { allowedPaths: [link] } }));
		const result = userResearchRoots({ ...u.env, ALLOWED_PATHS: u.add("e") }, u.home, u.octo);
		expect(result.warnings).toEqual([]);
		expect(result.roots).toHaveLength(5);
		expect(result.roots).toEqual([...result.roots].sort());
		expect(result.roots).toEqual(expect.arrayContaining([a, b, c, d]));
	});

	it("expands ~ and applies nothing when no source is set", () => {
		const u = user();
		expect(userResearchRoots(u.env, u.home, u.octo)).toEqual({ roots: [], warnings: [] });
		const inHome = folder(u.home, "code", "skills");
		u.settings(["~/code/skills"]);
		expect(userResearchRoots(u.env, u.home, u.octo).roots).toEqual([inHome]);
	});

	it("uses ~/.octocode for .env when OCTOCODE_HOME is unset", () => {
		const u = user();
		const a = u.add("a");
		folder(u.home, ".octocode");
		fs.writeFileSync(path.join(u.home, ".octocode", ".env"), `ALLOWED_PATHS=${a}\n`);
		expect(userResearchRoots({}, u.home, u.octo).roots).toEqual([a]);
	});
});

describe("user research roots: rejection list", () => {
	it.each([
		["relative", () => "rel/dir", /is not an absolute path/],
		["dotdot", (u: ReturnType<typeof user>) => `${u.add("x")}/../y`, /contains "\.\."/],
		["filesystem root", () => path.parse(os.tmpdir()).root, /filesystem root/],
		["home folder", (u: ReturnType<typeof user>) => u.home, /home folder/],
		["home as ~", () => "~", /home folder/],
		["Octocode home", (u: ReturnType<typeof user>) => u.octo, /Octocode home/],
		["inside Octocode home", (u: ReturnType<typeof user>) => folder(u.octo, "skills"), /Octocode home/],
		[
			"a folder that holds the home",
			(u: ReturnType<typeof user>) => path.dirname(u.home),
			/credential store|Octocode home/,
		],
		["~/.ssh", (u: ReturnType<typeof user>) => folder(u.home, ".ssh"), /credential store/],
		["inside ~/.aws", (u: ReturnType<typeof user>) => folder(u.home, ".aws", "sso"), /credential store/],
		["~/.gnupg", (u: ReturnType<typeof user>) => folder(u.home, ".gnupg"), /credential store/],
		["~/.config/gh", (u: ReturnType<typeof user>) => folder(u.home, ".config", "gh"), /credential store/],
		["~/.config (holds ~/.config/gh)", (u: ReturnType<typeof user>) => folder(u.home, ".config"), /credential store/],
		["a missing folder", (u: ReturnType<typeof user>) => path.join(u.home, "nope"), /does not exist; skipped/],
		[
			"a file",
			(u: ReturnType<typeof user>) => {
				const file = path.join(u.home, "file.txt");
				fs.writeFileSync(file, "x");
				return file;
			},
			/is not a folder/,
		],
		[
			"a symlink that resolves into ~/.ssh",
			(u: ReturnType<typeof user>) => {
				const link = path.join(real(tmp("roots-link-")), "innocent");
				fs.symlinkSync(folder(u.home, ".ssh"), link);
				return link;
			},
			/credential store/,
		],
		[
			"a symlink that resolves to the Octocode home",
			(u: ReturnType<typeof user>) => {
				const link = path.join(real(tmp("roots-link-")), "innocent");
				fs.symlinkSync(u.octo, link);
				return link;
			},
			/Octocode home/,
		],
	])("drops %s with a warning naming the source", (_name, make, reason) => {
		const u = user();
		const bad = make(u);
		const good = u.add("good");
		u.settings([bad, good]);
		const result = userResearchRoots(u.env, u.home, u.octo);
		expect(result.roots).toEqual([good]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toMatch(reason);
		expect(result.warnings[0]).toContain(path.join(u.octo, "settings.json"));
	});

	it("names the .env, .octocoderc and environment sources, and ignores entries that are not text", () => {
		const u = user();
		fs.writeFileSync(path.join(u.octo, ".env"), "ALLOWED_PATHS=rel1\n");
		fs.writeFileSync(path.join(u.octo, ".octocoderc"), JSON.stringify({ local: { allowedPaths: ["rel2", 7] } }));
		const { warnings, roots } = userResearchRoots({ ...u.env, ALLOWED_PATHS: "rel3" }, u.home, u.octo);
		expect(roots).toEqual([]);
		expect(warnings).toEqual([
			expect.stringContaining(`from ALLOWED_PATHS in ${path.join(u.octo, ".env")} is not an absolute path`),
			expect.stringContaining(`from local.allowedPaths in ${path.join(u.octo, ".octocoderc")} is not an absolute path`),
			expect.stringContaining("7 from local.allowedPaths"),
			expect.stringContaining('"rel3" from the ALLOWED_PATHS environment variable is not an absolute path'),
		]);
	});

	it("rejects a folder inside the private global state root", () => {
		const u = user();
		const session = folder(u.octo, "agent", "sessions", "abc");
		u.settings([session]);
		expect(userResearchRoots(u.env, u.home, u.octo)).toEqual({
			roots: [],
			warnings: [expect.stringContaining("Octocode home")],
		});
	});
});

describe("launch environment with user roots", () => {
	let u: ReturnType<typeof user>;
	let cwd: string;
	beforeEach(() => {
		u = user();
		cwd = real(tmp("roots-cwd-"));
		vi.stubEnv("OCTOCODE_HOME", u.octo);
		vi.stubEnv(ENV_AGENT_DIR, u.octo);
		vi.stubEnv("HOME", u.home);
		vi.stubEnv("ALLOWED_PATHS", undefined);
		takeOctocodeWarnings();
	});
	afterEach(() => vi.unstubAllEnvs());

	const sessions = () => [
		path.join(cwd, ".octa", "code", "session-data"),
		path.join(cwd, ".octa", "code", "temp", "sessions"),
	];
	const defaultServer = (skills: string[] = []): string[] => {
		const preset = octocodePreset(() => skills, process.env);
		const prepared = preset.prepareLaunch!(presetEntries([preset])[0], cwd, true);
		const env = (prepared.config as { env: Record<string, string> }).env;
		return resolveConfigValueOrThrow(env.ALLOWED_PATHS, "ALLOWED_PATHS").split(",");
	};
	const entry = (env?: Record<string, string>): McpServerEntry => ({
		name: "octocode",
		source: path.join(u.octo, "mcp.json"),
		config: { command: "octocode-mcp", ...(env ? { env } : {}) },
	});
	const configuredServer = (env?: Record<string, string>, skills: string[] = []): string[] | undefined => {
		const prepared = prepareOctocodeSkillLaunch(entry(env), cwd, skills, process.env);
		const value = (prepared.config as { env?: Record<string, string> }).env?.ALLOWED_PATHS;
		return value === undefined ? undefined : resolveConfigValueOrThrow(value, "ALLOWED_PATHS").split(",");
	};
	const automatic = (skills: string[] = []) => [cwd, ...sessions(), ...skills];

	it.each([
		["default server", (skills?: string[]) => defaultServer(skills)],
		["configured entry", (skills?: string[]) => configuredServer(undefined, skills)],
	])("%s: automatic roots alone when the user adds none", (_name, launch) => {
		expect(launch(["/skills/one"])).toEqual(automatic(["/skills/one"]));
	});

	it.each([
		["default server", (skills?: string[]) => defaultServer(skills)],
		["configured entry", (skills?: string[]) => configuredServer(undefined, skills)],
	])("%s: adds roots from settings, .env, .octocoderc and the process environment", (_name, launch) => {
		const [s, e, r, p] = [u.add("s"), u.add("e"), u.add("r"), u.add("p")];
		u.settings([s]);
		expect(launch()).toEqual([...automatic(), s]);
		fs.writeFileSync(path.join(u.octo, ".env"), `ALLOWED_PATHS=${e}\n`);
		expect(launch()).toEqual([...automatic(), ...[s, e].sort()]);
		fs.writeFileSync(path.join(u.octo, ".octocoderc"), JSON.stringify({ local: { allowedPaths: [r] } }));
		expect(launch()).toEqual([...automatic(), ...[s, e, r].sort()]);
		vi.stubEnv("ALLOWED_PATHS", p);
		expect(launch()).toEqual([...automatic(), ...[s, e, r, p].sort()]);
	});

	it.each([
		["default server", () => defaultServer()],
		["configured entry", () => configuredServer()],
	])("%s: the process ALLOWED_PATHS is additive, not a replacement", (_name, launch) => {
		const p = u.add("p");
		vi.stubEnv("ALLOWED_PATHS", p);
		expect(launch()).toEqual([...automatic(), p]);
	});

	it("an ALLOWED_PATHS in the configured entry's own env replaces every other root, with one warning", () => {
		u.settings([u.add("s")]);
		vi.stubEnv("ALLOWED_PATHS", u.add("p"));
		const replaced = prepareOctocodeSkillLaunch(entry({ ALLOWED_PATHS: "/only/this" }), cwd, [], process.env);
		expect((replaced.config as { env: Record<string, string> }).env.ALLOWED_PATHS).toBe("/only/this");
		prepareOctocodeSkillLaunch(entry({ ALLOWED_PATHS: "/only/this" }), cwd, [], process.env);
		expect(takeOctocodeWarnings().filter((w) => w.includes(path.join(u.octo, "mcp.json")))).toEqual([
			expect.stringContaining('ALLOWED_PATHS in the "octocode" entry of'),
		]);
	});

	it("warns about a rejected folder in the launch's warnings, once", () => {
		u.settings(["relative/folder"]);
		expect(defaultServer()).toEqual(automatic());
		defaultServer();
		expect(takeOctocodeWarnings()).toEqual([expect.stringContaining('"relative/folder" from research.allowedPaths')]);
	});

	it.each([false, true])("ignores a project settings.json research.allowedPaths (trusted: %s)", (trusted) => {
		const projectRoot = u.add("project-root");
		folder(cwd, ".octocode");
		fs.writeFileSync(
			path.join(cwd, ".octocode", "settings.json"),
			JSON.stringify({ research: { allowedPaths: [projectRoot] } }),
		);
		const preset = octocodePreset(() => [], process.env);
		const prepared = preset.prepareLaunch!(presetEntries([preset])[0], cwd, trusted);
		const env = (prepared.config as { env: Record<string, string> }).env;
		expect(resolveConfigValueOrThrow(env.ALLOWED_PATHS, "ALLOWED_PATHS").split(",")).toEqual(automatic());
		expect(configuredServer()).toEqual(automatic());
	});

	it("applies a changed setting at the next prepared launch", () => {
		const [a, b] = [u.add("a"), u.add("b")];
		u.settings([a]);
		expect(defaultServer()).toEqual([...automatic(), a]);
		u.settings([b]);
		expect(defaultServer()).toEqual([...automatic(), b]);
		u.settings([]);
		expect(defaultServer()).toEqual(automatic());
	});
});
