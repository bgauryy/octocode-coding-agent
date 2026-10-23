import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPluginManifests, resolvePluginPath } from "../src/core/plugin-manifest.ts";
const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-manifest-")); roots.push(dir); return dir; };
function write(dir: string, file: string, value: unknown) {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe("plugin manifest discovery", () => {
	it("keeps Claude and Codex identities separate in a dual-format package", () => {
		const dir = root();
		write(dir, ".claude-plugin/plugin.json", { name: "claude-one" });
		write(dir, ".codex-plugin/plugin.json", { name: "codex-one" });
		expect(discoverPluginManifests(dir).manifests.map((m) => [m.protocol, m.name])).toEqual([["claude", "claude-one"], ["codex", "codex-one"]]);
	});
	it("uses the portable identity and replaces the entire Codex overlay with an inline OpenAI object", () => {
		const dir = root();
		write(dir, "plugin.json", { name: "portable", extensions: { "com.openai": {} } });
		write(dir, ".codex-plugin/plugin.json", { name: "old", hooks: "./old.json" });
		const { manifests, errors } = discoverPluginManifests(dir);
		expect(errors).toEqual([]);
		expect(manifests).toHaveLength(1);
		expect(manifests[0]).toMatchObject({ name: "portable", format: "portable", settings: {} });
	});
	it("uses the compatibility overlay only for OpenAI settings when the inline object is absent", () => {
		const dir = root();
		write(dir, "plugin.json", { name: "portable" });
		write(dir, ".codex-plugin/plugin.json", { name: "old", hooks: "./hooks.json" });
		expect(discoverPluginManifests(dir).manifests[0]).toMatchObject({ name: "portable", settings: { hooks: "./hooks.json" } });
	});
	it("reports invalid JSON and identities without treating the directory as a valid plugin", () => {
		const dir = root();
		write(dir, ".claude-plugin/plugin.json", { name: "../escape" });
		fs.writeFileSync(path.join(dir, "plugin.json"), "{");
		const result = discoverPluginManifests(dir);
		expect(result.manifests).toEqual([]);
		expect(result.errors).toHaveLength(2);
	});
	it("does not read a manifest symlink outside its package", () => {
		const dir = root(); const outside = root();
		write(outside, "plugin.json", { name: "outside" });
		fs.symlinkSync(path.join(outside, "plugin.json"), path.join(dir, "plugin.json"));
		const result = discoverPluginManifests(dir);
		expect(result.manifests).toEqual([]);
		expect(result.errors[0]).toContain("escapes");
	});
	it.each(["../outside", "./../outside", "/absolute", "skills", "./a\\b"])("rejects non-contained component declaration %s", (entry) => {
		expect(() => resolvePluginPath(root(), entry)).toThrow("Invalid plugin-relative path");
	});
	it("resolves a package symlink root but rejects an escaping component symlink", () => {
		const dir = root(); const parent = root(); const outside = root();
		fs.mkdirSync(path.join(dir, "skills"));
		fs.symlinkSync(dir, path.join(parent, "linked"));
		expect(resolvePluginPath(path.join(parent, "linked"), "./skills")).toBe(fs.realpathSync(path.join(dir, "skills")));
		fs.symlinkSync(outside, path.join(dir, "outside"));
		expect(() => resolvePluginPath(dir, "./outside")).toThrow("escapes");
	});
	it("does not merge or read a malformed overlay when inline settings are present", () => {
		const dir = root();
		write(dir, "plugin.json", { name: "portable", extensions: { "com.openai": { hooks: "./inline.json" } } });
		write(dir, ".codex-plugin/plugin.json", null);
		const result = discoverPluginManifests(dir);
		expect(result.errors).toEqual([]);
		expect(result.manifests[0]?.sources).toEqual([fs.realpathSync(path.join(dir, "plugin.json"))]);
	});
	it("diagnoses a malformed inline object instead of silently falling back", () => {
		const dir = root();
		write(dir, "plugin.json", { name: "portable", extensions: { "com.openai": [] } });
		write(dir, ".codex-plugin/plugin.json", { name: "legacy" });
		expect(discoverPluginManifests(dir)).toEqual({ manifests: [], errors: [expect.stringContaining("must be an object")] });
	});

	it("does not fall back to a legacy identity when a portable manifest is invalid", () => {
		const dir = root();
		write(dir, "plugin.json", { name: 4 });
		write(dir, ".codex-plugin/plugin.json", { name: "legacy" });
		expect(discoverPluginManifests(dir).manifests).toEqual([]);
	});
	it("discovers manifestless Claude layout only when the caller explicitly selects Claude", () => {
		const dir = root();fs.mkdirSync(path.join(dir, "skills"));
		expect(discoverPluginManifests(dir).manifests).toEqual([]);
		expect(discoverPluginManifests(dir, { protocol: "claude" }).manifests).toContainEqual(expect.objectContaining({ name: path.basename(dir), protocol: "claude", sources: [] }));
		write(dir, ".claude-plugin/plugin.json", { name: "../invalid" });
		expect(discoverPluginManifests(dir, { protocol: "claude" }).manifests).toEqual([]);
	});
	it("accepts safe non-kebab names and Codex's missing-name directory fallback", () => {
		const dir = root();
		write(dir, ".claude-plugin/plugin.json", { name: "Review_Kit" });
		write(dir, ".codex-plugin/plugin.json", {});
		expect(discoverPluginManifests(dir).manifests.map(m => m.name)).toEqual(["Review_Kit", path.basename(dir)]);
	});

});
