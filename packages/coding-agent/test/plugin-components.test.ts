import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPluginComponents } from "../src/core/plugin-components.ts";
import type { PluginManifest } from "../src/core/plugin-manifest.ts";
const roots: string[] = [];
function fixture(protocol: "claude" | "codex", settings: Record<string, unknown>): PluginManifest {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-components-"))); roots.push(root);
	for (const dir of ["skills", "extra", "commands", "custom", "hooks"]) fs.mkdirSync(path.join(root, dir));
	fs.writeFileSync(path.join(root, "hooks/hooks.json"), '{"hooks":{}}');
	fs.writeFileSync(path.join(root, "extra.json"), '{"hooks":{}}');
	return { protocol, format: protocol, name: "fixture", root, sources: [path.join(root, "manifest.json")], metadata: {}, settings };
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe("plugin component declarations", () => {
	it("adds Claude skill directories and replaces command defaults", () => {
		const m = fixture("claude", { skills: "./extra", commands: "./custom" });
		const result = discoverPluginComponents(m);
		expect(result.errors).toEqual([]);
		expect(result.skills).toEqual([path.join(m.root, "skills"), path.join(m.root, "extra")]);
		expect(result.commands).toEqual([{ kind: "path", path: path.join(m.root, "custom") }]);
	});
	it("merges Claude defaults and mixed declaration order", () => {
		const inline = { Stop: [] };
		const m = fixture("claude", { hooks: ["./extra.json", inline] });
		expect(discoverPluginComponents(m).hooks).toEqual([
			{ kind: "path", path: path.join(m.root, "hooks/hooks.json") },
			{ kind: "path", path: path.join(m.root, "extra.json") }, { kind: "inline", value: { hooks: inline } },
		]);
	});
	it("preserves Codex inline HooksFile wrappers", () => {
		const inline = { hooks: { Stop: [] } };
		const m = fixture("codex", { hooks: [inline] });
		expect(discoverPluginComponents(m).hooks).toEqual([{ kind: "inline", value: inline }]);
	});
	it("rejects mixed Codex path and inline arrays instead of accepting Claude semantics", () => {
		const result = discoverPluginComponents(fixture("codex", { hooks: ["./extra.json", { hooks: { Stop: [] } }] }));
		expect(result.hooks).toEqual([]);
		expect(result.errors).toContainEqual(expect.stringContaining("homogeneous"));
	});
	it("rejects an unwrapped Codex event map", () => {
		const result = discoverPluginComponents(fixture("codex", { hooks: { Stop: [] } }));
		expect(result.hooks).toEqual([]);
		expect(result.errors).toContainEqual(expect.stringContaining("hooks wrapper"));
	});

	it("uses portable fixed skills instead of overlay skills", () => {
		const m = { ...fixture("codex", { skills: "./extra" }), format: "portable" as const };
		expect(discoverPluginComponents(m).skills).toEqual([path.join(m.root, "skills")]);
	});
	it("uses the Codex default when an empty declaration resolves to no hook paths", () => {
		const manifest = fixture("codex", { hooks: [] });
		expect(discoverPluginComponents(manifest).hooks).toEqual([{ kind: "path", path: path.join(manifest.root, "hooks/hooks.json") }]);
	});
	it("validates and preserves named Claude command bodies and metadata", () => {
		const m = fixture("claude", { commands: { about: { content: "About this plugin", description: "About" }, bad: { source: "./custom", content: "ambiguous" } } });
		const result = discoverPluginComponents(m);
		expect(result.commands).toEqual([{ kind: "command", name: "about", definition: { content: "About this plugin", description: "About" } }]);
		expect(result.errors).toContainEqual(expect.stringContaining("exactly one"));
	});
	it("diagnoses escaping default symlinks and invalid declared resource kinds", () => {
		const m = fixture("claude", { skills: "./extra.json", hooks: "./custom" });
		fs.rmSync(path.join(m.root, "skills"), { recursive: true });
		fs.symlinkSync(os.tmpdir(), path.join(m.root, "skills"));
		const result = discoverPluginComponents(m);
		expect(result.skills).toEqual([]);
		expect(result.errors).toHaveLength(3);
	});
	it.each([null, 5])("does not load default commands for invalid explicit declaration %s", (commands) => {
		const result = discoverPluginComponents(fixture("claude", { commands }));
		expect(result.commands).toEqual([]);
		expect(result.errors).toHaveLength(1);
	});
	it("rejects mixed source/content keys even when one has the wrong type", () => {
		const result = discoverPluginComponents(fixture("claude", { commands: { bad: { content: "body", source: null } } }));
		expect(result.commands).toEqual([]);
		expect(result.errors[0]).toContain("exactly one");
	});

	it("deduplicates paths by resolved identity", () => {
		const m = fixture("claude", { skills: ["./skills", "./extra", "./alias"] });
		fs.symlinkSync(path.join(m.root, "extra"), path.join(m.root, "alias"));
		expect(discoverPluginComponents(m).skills).toEqual([path.join(m.root, "skills"), path.join(m.root, "extra")]);
	});
});
