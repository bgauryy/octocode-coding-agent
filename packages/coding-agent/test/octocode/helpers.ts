import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import type { Fetched } from "../../src/octocode/web/fetch.ts";
import { configDiscovery, discoveryInput } from "../../src/core/discovery/service.ts";
import { grantFolder } from "../../src/octocode/trust/grants.ts";
import type { Toggles } from "../../src/core/extensibility/toggles.ts";

/**
 * The `/harness` switches of a user who turned Claude Code and Codex on. Their hook files (and Claude permission rules)
 * stay off by default, so a suite that tests what those files do starts from these toggles.
 */
export const HOOK_HARNESSES_ON: Toggles = Object.freeze({ "harness:claude": true, "harness:codex": true });

/** Settings with {@link HOOK_HARNESSES_ON}: for `fakeHost(...)`, `loadHooks(..., options)` or a settings file. */
export const HOOK_SETTINGS = Object.freeze({ toggles: HOOK_HARNESSES_ON });

/**
 * Records the decision a user would have made for a fixture's project folder, in the agent database `env` selects (the
 * process's by default; call it after the test has pointed OCTOCODE_HOME at its own). A real `octocode` process started in
 * the folder then passes the trust gate; the production code has no test-only switch.
 */
export function trustFolder(dir: string, env: NodeJS.ProcessEnv = process.env): void {
	grantFolder(dir, "folder", { source: "command", surface: "cli" }, { env });
}

const created: string[] = [];

/** A fresh temporary directory, removed when the test process exits. */
export function tmp(prefix = "octocode-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(dir);
	return dir;
}

process.once("exit", () => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fetched page's text; a case that expects text fails on an image or a transport notice. */
export function asText(fetched: Fetched): string {
	if (typeof fetched !== "string")
		throw new Error(
			`expected page text, got ${"kind" in fetched ? `a ${fetched.reason} notice` : `an ${fetched.mimeType} image`}`,
		);
	return fetched;
}

/** A square RGBA png of incompressible pseudo-random pixels: `size` 512 encodes to about 1 MB. */
export function noisyPng(size: number): Buffer {
	const pixels = new Uint8Array(size * size * 4);
	let random = 17;
	for (let index = 0; index < pixels.length; index++) {
		random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
		pixels[index] = index % 4 === 3 ? 255 : random >>> 24;
	}
	const image = new PhotonImage(pixels, size, size);
	try {
		return Buffer.from(image.get_bytes());
	} finally {
		image.free();
	}
}

/** The pixel size of a decoded base64 or raw png/jpeg/webp image. */
export function pixelSize(image: string | Uint8Array): { width: number; height: number } {
	const decoded = PhotonImage.new_from_byteslice(typeof image === "string" ? Buffer.from(image, "base64") : image);
	try {
		return { width: decoded.get_width(), height: decoded.get_height() };
	} finally {
		decoded.free();
	}
}

/** Every prompt section an event's handlers wrote: base sections (cached with the tools) first, then the session's. */
export function allSections(event: {
	systemPromptOptions: { sections: Record<string, string>; baseSections?: Record<string, string> };
}): Record<string, string> {
	return { ...event.systemPromptOptions.baseSections, ...event.systemPromptOptions.sections };
}

/**
 * The skill files other agents' folders (Claude Code, Codex, Cursor) hold for a workspace, with their harness switched on,
 * as core discovery lists them: the same discovery the runtime loads skills through.
 */
export function vendorSkillFiles(
	cwd: string,
	home: string,
	projectTrusted = true,
	env: NodeJS.ProcessEnv = {},
): string[] {
	const toggles = { "harness:claude": true, "harness:codex": true, "harness:cursor": true };
	return configDiscovery
		.discover("skill", discoveryInput({ cwd, agentDir: tmp(), home, projectTrusted, env, piRoots: [], toggles }))
		.filter(({ provenance }) => ["claude", "codex", "cursor"].includes(provenance.vendor))
		.map(({ provenance }) => provenance.path);
}
