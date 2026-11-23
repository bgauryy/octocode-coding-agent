import "../mcp-host.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfigValueOrThrow } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { expandLaunchTemplates } from "../../../mcp/src/launch-templates.ts";
import { presetEntries } from "../../../mcp/src/preset.ts";
import { recommendedPresets } from "../../../mcp/src/recommended/index.ts";
import { takeLaunchWarnings } from "../../../mcp/src/warnings.ts";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { hostPaths } from "../../../mcp/src/host.ts";
import { ENV_AGENT_DIR, getNativeSkillsDir } from "../../src/config.ts";
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

describe("user research roots: unreadable sources", () => {
	it("warns, naming the file, when settings.json or .octocoderc is not valid JSON", () => {
		const u = user();
		fs.writeFileSync(path.join(u.octo, "settings.json"), "{ not json");
		fs.writeFileSync(path.join(u.octo, ".octocoderc"), "{ not json");
		const result = userResearchRoots(u.env, u.home, u.octo);
		expect(result.roots).toEqual([]);
		expect(result.warnings.some((warning) => warning.includes(path.join(u.octo, "settings.json")))).toBe(true);
		expect(result.warnings.some((warning) => warning.includes(path.join(u.octo, ".octocoderc")))).toBe(true);
	});
});

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
		takeLaunchWarnings();
	});
	afterEach(() => vi.unstubAllEnvs());

	const sessions = () => [
		path.join(cwd, ".octocode", "agent", "session-data"),
		path.join(cwd, ".octocode", "agent", "temp", "sessions"),
	];
	/** The default server's `ALLOWED_PATHS`, as the host expands its launch templates for a session. */
	const launchRoots = (skills: string[] = [], projectTrusted = true): string[] => {
		const [preset] = recommendedPresets(process.env);
		const prepared = expandLaunchTemplates(presetEntries([preset])[0], {
			cwd,
			projectTrusted,
			skillDirectories: skills,
			env: process.env,
		});
		const env = (prepared.config as { env: Record<string, string> }).env;
		return resolveConfigValueOrThrow(env.ALLOWED_PATHS, "ALLOWED_PATHS").split(",");
	};
	const defaultServer = (skills: string[] = []): string[] => launchRoots(skills);
	// The bundled skill folder the session's discovery adds is named from session start, whole (`announcedSkillRoots`).
	const bundled = real(getNativeSkillsDir());
	const automatic = (skills: string[] = []) => [cwd, ...sessions(), ...[bundled, ...skills].sort()];

	it("announces the bundled skill folder as a realpath, in a subagent too, whose parent's inventory holds it", () => {
		expect(hostPaths().announcedSkillRoots?.({ cwd, projectTrusted: true })).toEqual([bundled]);
		vi.stubEnv(SUBAGENT_ENV, "1");
		expect(hostPaths().announcedSkillRoots?.({ cwd, projectTrusted: true })).toEqual([bundled]);
	});

	it("default server: a shipped skill the user switched off stays outside ALLOWED_PATHS, before and after discovery", () => {
		// The pattern `/skills` writes for a core skill switched off globally (`harness-skills.test.ts`).
		fs.writeFileSync(path.join(u.octo, "settings.json"), JSON.stringify({ skills: ["-octocode-debugging/SKILL.md"] }));
		const shipped = fs.readdirSync(bundled).filter((name) => fs.existsSync(path.join(bundled, name, "SKILL.md")));
		expect(shipped).toContain("octocode-debugging");
		const enabled = shipped.filter((name) => name !== "octocode-debugging").map((name) => path.join(bundled, name));
		const atStart = defaultServer();
		expect(atStart).not.toContain(bundled);
		expect(atStart).not.toContain(path.join(bundled, "octocode-debugging"));
		expect(atStart).toEqual([cwd, ...sessions(), ...enabled.sort()]);
		// Discovery loads those same folders: the launch does not change, so the server keeps its early start.
		expect(defaultServer(enabled)).toEqual(atStart);
	});

	it("default server: a loaded bundled skill's folder is reached through the bundled folder", () => {
		const skill = path.join(bundled, fs.readdirSync(bundled)[0]);
		expect(defaultServer([skill, "/skills/one"])).toEqual(automatic(["/skills/one"]));
	});

	it("default server: automatic roots alone when the user adds none", () => {
		expect(defaultServer(["/skills/one"])).toEqual(automatic(["/skills/one"]));
	});

	it("default server: adds roots from settings, .env, .octocoderc and the process environment", () => {
		const launch = defaultServer;
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

	it("default server: the process ALLOWED_PATHS is additive, not a replacement", () => {
		const p = u.add("p");
		vi.stubEnv("ALLOWED_PATHS", p);
		expect(defaultServer()).toEqual([...automatic(), p]);
	});

	it("warns about a rejected folder in the launch's warnings, once", () => {
		u.settings(["relative/folder"]);
		expect(defaultServer()).toEqual(automatic());
		defaultServer();
		expect(takeLaunchWarnings()).toEqual([expect.stringContaining('"relative/folder" from research.allowedPaths')]);
	});

	it.each([false, true])("ignores a project settings.json research.allowedPaths (trusted: %s)", (trusted) => {
		const projectRoot = u.add("project-root");
		folder(cwd, ".octocode");
		fs.writeFileSync(
			path.join(cwd, ".octocode", "settings.json"),
			JSON.stringify({ research: { allowedPaths: [projectRoot] } }),
		);
		expect(launchRoots([], trusted)).toEqual(automatic());
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
