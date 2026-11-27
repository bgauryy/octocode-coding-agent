import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialHit } from "../../src/octocode/permission/credential-store.ts";
import { tmp } from "./helpers.ts";

/**
 * The fixed credential paths are canonicalized once and reused while the folders they resolve through are unchanged
 * (`canonicalPaths`). These checks change those folders between calls in one process, as a session would, and expect
 * the same answers a fresh check gives. Synthetic files in a temp home only: no test reads a real credential file.
 */
const saved = { ...process.env };
let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.realpathSync(tmp("octocode-cred-cache-"));
	cwd = fs.realpathSync(tmp("octocode-cred-cache-cwd-"));
	for (const name of ["OCTOCODE_CODING_AGENT_DIR", "OCTOCODE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_DATA_HOME"])
		delete process.env[name];
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	fs.mkdirSync(path.join(home, ".octocode", "octocodecode"), { recursive: true });
});

afterEach(() => {
	for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
	Object.assign(process.env, saved);
});

const reads = (file: string) => credentialHit("bash", { command: `cat ${file}` }, cwd);

describe("credential paths changed mid-session", () => {
	it("a CLI credential folder that appears as a symlink makes its target a credential file", () => {
		const elsewhere = path.join(cwd, "elsewhere");
		fs.mkdirSync(elsewhere);
		const target = path.join(elsewhere, "credentials");
		fs.writeFileSync(target, "[default]");
		expect(reads(target)).toBeUndefined();
		expect(reads(target)).toBeUndefined();
		fs.symlinkSync(elsewhere, path.join(home, ".aws"));
		expect(reads(target)?.found).toBe(target);
		fs.rmSync(path.join(home, ".aws"));
		expect(reads(target)).toBeUndefined();
	});

	it("Octocode's store created as a symlink makes the file it points to the store", () => {
		const secret = path.join(cwd, "secret.json");
		fs.writeFileSync(secret, "{}");
		expect(reads(secret)).toBeUndefined();
		fs.symlinkSync(secret, path.join(home, ".octocode", "octocodecode", "auth.json"));
		expect(reads(secret)?.found).toBe(secret);
	});

	it("a vendor store folder retargeted between calls follows the new target", () => {
		for (const dir of ["a", "b"]) {
			fs.mkdirSync(path.join(cwd, dir));
			fs.writeFileSync(path.join(cwd, dir, "auth.json"), "{}");
		}
		fs.symlinkSync(path.join(cwd, "a"), path.join(home, ".codex"));
		expect(reads(path.join(cwd, "a", "auth.json"))?.store?.id).toBe("codex");
		expect(reads(path.join(cwd, "b", "auth.json"))).toBeUndefined();
		fs.rmSync(path.join(home, ".codex"));
		fs.symlinkSync(path.join(cwd, "b"), path.join(home, ".codex"));
		expect(reads(path.join(cwd, "b", "auth.json"))?.store?.id).toBe("codex");
		expect(reads(path.join(cwd, "a", "auth.json"))).toBeUndefined();
	});

	it("a changed home variable is a different list, not a stale one", () => {
		const first = path.join(cwd, "first");
		fs.mkdirSync(first);
		process.env.CODEX_HOME = first;
		expect(reads(path.join(first, "auth.json"))?.store?.id).toBe("codex");
		const second = path.join(cwd, "second");
		fs.mkdirSync(second);
		process.env.CODEX_HOME = second;
		expect(reads(path.join(second, "auth.json"))?.store?.id).toBe("codex");
		expect(reads(path.join(first, "auth.json"))).toBeUndefined();
	});
});
