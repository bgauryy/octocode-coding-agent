import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INLINE_MAX_CHARS, imagesOf, saveShot, ShotWriter } from "../../src/octocode/subagents/screenshots.ts";
import { createPng } from "../image-fixtures.ts";
import { tmp } from "./helpers.ts";

describe("subagent screenshots", () => {
	it("finds image parts in a tool result", () => {
		expect(
			imagesOf({
				content: [
					{ type: "text", text: "x" },
					{ type: "image", data: "AA", mimeType: "image/jpeg" },
					{ type: "image", data: "BB" },
				],
			}),
		).toEqual([
			{ data: "AA", mimeType: "image/jpeg" },
			{ data: "BB", mimeType: "image/png" },
		]);
		expect(imagesOf({ content: "nope" })).toEqual([]);
		expect(imagesOf(undefined)).toEqual([]);
	});

	it("publishes an artifact for a 400×400 screenshot that exceeds the terminal frame budget", async () => {
		const bytes = createPng(400, 400, true);
		const shot = await saveShot(path.join(tmp(), "shots"), "browser", 1, {
			data: bytes.toString("base64"),
			mimeType: "image/png",
		});
		expect(Buffer.byteLength(bytes.toString("base64"))).toBeGreaterThan(512 * 1024);
		expect(shot.data).toBeUndefined();
		expect(bytes.toString("base64").length).toBeLessThan(700_000);
		expect(fs.readFileSync(shot.path).equals(bytes)).toBe(true);
	});

	it("saves the picture, draws small ones inline and keeps only the newest files", async () => {
		const dir = path.join(tmp(), "shots");
		const png = Buffer.from("png-bytes").toString("base64");
		const shot = await saveShot(dir, "browser-1", 1, { data: png, mimeType: "image/png" });
		expect(fs.readFileSync(shot.path).toString()).toBe("png-bytes");
		expect(shot.data).toBe(png);
		const big = await saveShot(dir, "browser-1", 2, { data: "A".repeat(INLINE_MAX_CHARS + 4), mimeType: "image/png" });
		expect(big.data).toBeUndefined();
		const writer = new ShotWriter(dir, "other");
		let latest = "";
		for (let i = 1; i <= 42; i++)
			writer.add({ data: png, mimeType: "image/png" }, (saved) => {
				latest = saved.path;
			});
		await writer.finish();
		expect(latest).toBe(path.join(dir, "other-42.png"));
		expect(fs.existsSync(latest)).toBe(true);
		expect(fs.readdirSync(dir)).toHaveLength(30);
	});

	it("bounds queued previews behind a large write and drains the newest one", async () => {
		const dir = path.join(tmp(), "shots");
		const writer = new ShotWriter(dir, "browser");
		const saved: string[] = [];
		const image = { data: "A".repeat(2 * 1024 * 1024), mimeType: "image/png" };
		for (let i = 0; i < 5; i++) writer.add(image, (shot) => saved.push(path.basename(shot.path)));
		expect(saved).toEqual([]);
		await writer.finish();
		expect(saved).toEqual(["browser-1.png", "browser-5.png"]);
	});

	it.skipIf(process.platform === "win32")(
		"keeps the folder and its pictures owner-only, even over an older world-readable file",
		async () => {
			const dir = path.join(tmp(), "shots");
			fs.mkdirSync(dir, { mode: 0o755 });
			fs.writeFileSync(path.join(dir, "a-1.png"), "old", { mode: 0o644 });
			const first = await saveShot(dir, "a", 1, { data: "AAAA", mimeType: "image/png" });
			const second = await saveShot(dir, "a", 2, { data: "AAAA", mimeType: "image/jpeg" });
			expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
			expect(fs.statSync(first.path).mode & 0o777).toBe(0o600);
			expect(fs.statSync(second.path).mode & 0o777).toBe(0o600);
		},
	);
});
