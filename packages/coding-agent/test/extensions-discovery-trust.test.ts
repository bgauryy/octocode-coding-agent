import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-ext-trust-"));
	cwd = path.join(root, "project");
	agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(cwd, ".octocode", "extensions"), { recursive: true });
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "extensions", "local.ts"), "export default () => {};");
	fs.writeFileSync(path.join(agentDir, "extensions", "global.ts"), "export default () => {};");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const loaded = async (options?: { projectTrusted?: boolean }) =>
	(await discoverAndLoadExtensions([], cwd, agentDir, undefined, options)).extensions.map((extension) =>
		path.basename(extension.path),
	);

it("skips project extensions in an untrusted project", async () => {
	expect(await loaded()).toEqual(["global.ts"]);
	expect(await loaded({ projectTrusted: false })).toEqual(["global.ts"]);
});

it("loads project extensions once the project is trusted or the caller vouches for it", async () => {
	expect(await loaded({ projectTrusted: true })).toEqual(["local.ts", "global.ts"]);
	new ProjectTrustStore(agentDir).set(cwd, true);
	expect(await loaded()).toEqual(["local.ts", "global.ts"]);
});
