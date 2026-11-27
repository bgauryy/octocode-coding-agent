import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** Pasting an image path through bracketed paste, as a terminal sends a dropped file. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

/** A valid 1x1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

const on = (pattern: string) => async () => (await t!.text()).includes(pattern);

/** The image blocks of the one recorded request. */
function imagesOf(request: string): Array<{ type: string; data?: string; mimeType?: string }> {
	const found: Array<{ type: string; data?: string; mimeType?: string }> = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") {
			const block = value as { type?: string };
			if (block.type === "image") found.push(block as { type: string });
			Object.values(value).forEach(walk);
		}
	};
	walk(JSON.parse(request));
	return found;
}

describe("image path paste", () => {
	it("a pasted image path shows in the editor and the request carries an image block with the file's bytes", async () => {
		t = await startUi();
		const file = path.join(t.cwd, "shot.png");
		fs.writeFileSync(file, PNG);
		t.press(paste(file));
		await t.until(on("shot.png"), "pasted path in the editor");
		t.script("nice picture");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		const images = imagesOf(t.requests[0]);
		expect(images).toHaveLength(1);
		expect(images[0].mimeType).toBe("image/png");
		expect(images[0].data).toBe(PNG.toString("base64"));
		// The path text is kept in the prompt as typed.
		expect(t.requests[0]).toContain("shot.png");
		await t.until(on("nice picture"), "reply on screen");
	});

	it("text around the pasted path is kept and still attaches the image", async () => {
		t = await startUi();
		const file = path.join(t.cwd, "ui.png");
		fs.writeFileSync(file, PNG);
		await t.type("what is in ");
		t.press(paste(file));
		await t.until(on("ui.png"), "pasted path in the editor");
		t.script("a pixel");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		expect(t.requests[0]).toContain("what is in");
		expect(imagesOf(t.requests[0])).toHaveLength(1);
	});

	it("a pasted path to a file that does not exist stays plain text with no image block", async () => {
		t = await startUi();
		const file = path.join(t.cwd, "missing.png");
		t.press(paste(file));
		await t.until(on("missing.png"), "pasted path in the editor");
		t.script("nothing there");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		expect(imagesOf(t.requests[0])).toHaveLength(0);
		expect(t.requests[0]).toContain("missing.png");
	});

	it("a pasted .png path whose bytes are not an image is not attached", async () => {
		t = await startUi();
		const file = path.join(t.cwd, "fake.png");
		fs.writeFileSync(file, "just text\n");
		t.press(paste(file));
		await t.until(on("fake.png"), "pasted path in the editor");
		t.script("ok");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		expect(imagesOf(t.requests[0])).toHaveLength(0);
	});
});
