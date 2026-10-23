import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	stageSettingsWrite,
	persistSettingsWrite,
} from "../../src/octocode/permission/source-policy-storage.ts";
import { parsePermissionUpdates } from "../../src/octocode/shared/permission-updates.ts";
const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-storage-"));
	roots.push(root);
	const file = path.join(root, "settings.json");
	const initial = {
		hooks: { SessionStart: [] },
		other: "preserved",
		permissions: { deny: ["Bash(protected)"] },
	};
	fs.writeFileSync(file, JSON.stringify(initial));
	const updates = parsePermissionUpdates([
		{
			type: "addRules",
			rules: [{ toolName: "Bash", ruleContent: "node -p 42" }],
			behavior: "allow",
			destination: "userSettings",
		},
	]);
	return {
		root,
		file,
		initial,
		plan: stageSettingsWrite(
			{ path: file, anchor: root },
			"userSettings",
			updates,
		),
	};
}
it("atomically persists only the requested permission rules and preserves other settings", async () => {
	const f = fixture();
	expect(
		await persistSettingsWrite(f.plan, new AbortController().signal),
	).toEqual({ written: true });
	expect(JSON.parse(fs.readFileSync(f.file, "utf8"))).toEqual({
		...f.initial,
		permissions: {
			allow: ["Bash(node -p 42)"],
			deny: ["Bash(protected)"],
			ask: [],
		},
	});
	expect(fs.readdirSync(f.root)).toEqual(["settings.json"]);
});
it("treats changed bytes as lost authorization rather than an IO fallback", async () => {
	const f = fixture();
	fs.writeFileSync(
		f.file,
		JSON.stringify({ ...f.initial, other: "concurrent" }),
	);
	await expect(
		persistSettingsWrite(f.plan, new AbortController().signal),
	).rejects.toThrow(/changed/);
	expect(JSON.parse(fs.readFileSync(f.file, "utf8")).other).toBe("concurrent");
});
it("refuses same-byte symlink retarget before commit", async () => {
	const f = fixture();
	const other = path.join(f.root, "other.json");
	fs.copyFileSync(f.file, other);
	fs.unlinkSync(f.file);
	fs.symlinkSync(other, f.file);
	await expect(
		persistSettingsWrite(f.plan, new AbortController().signal),
	).rejects.toThrow(/identity/);
	expect(JSON.parse(fs.readFileSync(other, "utf8"))).toEqual(f.initial);
});
it("reports a real writer IO failure without replacing existing bytes or leaking temp files", async () => {
	const f = fixture();
	const failure = Object.assign(new Error("denied"), { code: "EACCES" });
	vi.spyOn(fs.promises, "rename").mockRejectedValueOnce(failure);
	expect(
		await persistSettingsWrite(f.plan, new AbortController().signal),
	).toMatchObject({
		written: false,
		message: expect.stringContaining("not saved"),
	});
	expect(JSON.parse(fs.readFileSync(f.file, "utf8"))).toEqual(f.initial);
	expect(fs.readdirSync(f.root)).toEqual(["settings.json"]);
});
it("does not start a write after cancellation", async () => {
	const f = fixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		persistSettingsWrite(f.plan, controller.signal),
	).rejects.toThrow();
	expect(JSON.parse(fs.readFileSync(f.file, "utf8"))).toEqual(f.initial);
});
