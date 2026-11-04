import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CallToolResult } from "../src/client/index.ts";
import { HAR_BODIES_HINT } from "../src/presets/browser/presentation.ts";
import { defineBrowserTool } from "../src/presets/browser/tools.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

/** A valid `width` x `height` grey PNG. */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const head = Buffer.alloc(4);
		head.writeUInt32BE(data.length);
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc32(body));
		return Buffer.concat([head, body, tail]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 0, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 128)]);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

interface Call {
	name: string;
	args: Record<string, unknown>;
}

function harness(toolName: string, reply: () => CallToolResult) {
	const calls: Call[] = [];
	const definition = defineBrowserTool({
		server: "browser",
		tool: { name: toolName, inputSchema: { type: "object", properties: { options: { type: "object" } } } },
		name: `mcp__browser__${toolName}`,
		exposure: "direct",
		namespace: "mcp" as never,
		timeoutMs: 1000,
		getClient: async () => ({
			callTool: async (name, args) => {
				calls.push({ name, args });
				return reply();
			},
		}),
	});
	const run = (cwd: string, args: Record<string, unknown> = {}) =>
		definition.execute("call", args, undefined, undefined, { cwd, model: undefined } as never);
	return { calls, run };
}

/** A capture folder under `cwd` the way the package lays it out; returns its absolute path. */
function captureFolder(cwd: string, name = "2026-10-26-10-00-00"): string {
	const root = join(cwd, ".octocode", "octocode-chrome-devtools", "tmp", name);
	mkdirSync(root, { recursive: true });
	return root;
}

function manifestReply(root: string, tiles: string[]): CallToolResult {
	writeFileSync(
		join(root, "screenshot-manifest.json"),
		JSON.stringify({
			mode: tiles.length > 1 ? "full" : "viewport",
			tiles: tiles.map((file, i) => ({ index: i + 1, file })),
		}),
	);
	return {
		content: [{ type: "text", text: "OK" }],
		structuredContent: {
			ok: true,
			root,
			artifacts: [{ label: "screenshot-manifest.json", path: "screenshot-manifest.json" }],
		},
	};
}

const imagesOf = (result: { content: Array<{ type: string }> }) =>
	result.content.filter((part) => part.type === "image");
const textOf = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

describe("browser screenshot results", () => {
	it("attaches a viewport screenshot as an image and names its full path", async () => {
		const cwd = tmp();
		const root = captureFolder(cwd);
		const file = join(root, "screenshot.png");
		writeFileSync(file, png(64, 48));
		const { run } = harness("screenshot", () => manifestReply(root, [file]));
		const result = await run(cwd);
		const [image] = imagesOf(result);
		expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
		expect((image as unknown as { data: string }).data).toBe(png(64, 48).toString("base64"));
		expect(textOf(result)).toContain(file);
		expect(textOf(result)).toContain('"ok":true');
	});

	it("attaches only the first tile of a full-page shot and lists every tile path", async () => {
		const cwd = tmp();
		const root = captureFolder(cwd);
		const tiles = ["screenshot-full.png", "screenshot-full-2.png", "screenshot-full-3.png"].map((name) =>
			join(root, name),
		);
		tiles.forEach((tile) => writeFileSync(tile, png(32, 32)));
		const { run } = harness("check", () => manifestReply(root, tiles));
		const result = await run(cwd);
		expect(imagesOf(result)).toHaveLength(1);
		const text = textOf(result);
		for (const tile of tiles) expect(text).toContain(tile);
		expect(text).toContain(`(tile 1 of 3, image attached): ${tiles[0]}`);
	});

	it("fits a tall tile to the model's image limits and keeps the original path", async () => {
		const cwd = tmp();
		const root = captureFolder(cwd);
		const file = join(root, "tall.png");
		writeFileSync(file, png(300, 3000));
		const { run } = harness("screenshot", () => manifestReply(root, [file]));
		const result = await run(cwd);
		expect(imagesOf(result)).toHaveLength(1);
		expect(textOf(result)).toContain(file);
		expect(textOf(result)).toMatch(/original 300x3000, displayed at 157x1568/);
	});

	it("attaches at most two images when the result lists several", async () => {
		const cwd = tmp();
		const root = captureFolder(cwd);
		const names = ["a.png", "b.png", "c.png"];
		names.forEach((name, index) => writeFileSync(join(root, name), png(16 + index, 16)));
		const { run } = harness("screenshot", () => ({
			content: [{ type: "text", text: "OK" }],
			structuredContent: { root, artifacts: names.map((path) => ({ label: path, path })) },
		}));
		const result = await run(cwd);
		expect(imagesOf(result)).toHaveLength(2);
		for (const name of names) expect(textOf(result)).toContain(join(root, name));
	});

	it("never reads a path outside the capture folder", async () => {
		const cwd = tmp();
		const root = captureFolder(cwd);
		const outside = join(tmp(), "secret.png");
		writeFileSync(outside, png(16, 16));
		const { run } = harness("screenshot", () => manifestReply(root, [outside, "../../../../../secret.png"]));
		const result = await run(cwd);
		expect(imagesOf(result)).toHaveLength(0);
		expect(textOf(result)).not.toContain(outside);
	});

	it("ignores files that are not images", async () => {
		const cwd = tmp();
		const root = captureFolder(cwd);
		const file = join(root, "fake.png");
		writeFileSync(file, "not an image");
		const { run } = harness("screenshot", () => manifestReply(root, [file]));
		expect(imagesOf(await run(cwd))).toHaveLength(0);
	});
});

describe("browser call options", () => {
	it("sends booleans as 1/0 and numbers as text to screenshot, snapshot and check", async () => {
		for (const tool of ["screenshot", "snapshot", "check"]) {
			const { calls, run } = harness(tool, () => ({ content: [{ type: "text", text: "OK" }] }));
			await run(tmp(), {
				options: { SHOT_ANNOTATE: true, SHOT_FULL: false, SHOT_SCALE: 1, SHOT_QUALITY: "80" },
				recipe: "page-screenshot",
			});
			expect(calls).toEqual([
				{
					name: tool,
					args: {
						options: { SHOT_ANNOTATE: "1", SHOT_FULL: "0", SHOT_SCALE: "1", SHOT_QUALITY: "80" },
						recipe: "page-screenshot",
					},
				},
			]);
		}
	});

	it("leaves other tools' arguments as the model wrote them", async () => {
		const { calls, run } = harness("run", () => ({ content: [{ type: "text", text: "OK" }] }));
		const args = { options: { flag: true }, plan: { steps: [] } };
		await run(tmp(), args);
		expect(calls[0].args).toEqual(args);
	});
});

describe("browser network captures", () => {
	const reply = (paths: string[]): CallToolResult => ({
		content: [{ type: "text", text: "OK" }],
		structuredContent: { root: "/x", artifacts: paths.map((path) => ({ label: path, path })) },
	});

	it("notes that a HAR has no bodies and names the recipe that fetches them", async () => {
		const { run } = harness("check", () => reply(["events.ndjson", "live-network.har"]));
		const text = textOf(await run(tmp()));
		expect(text).toContain(HAR_BODIES_HINT);
		expect(HAR_BODIES_HINT).toContain("network-body-har-fetch-check");
	});

	it("stays quiet when the capture holds bodies or has no HAR", async () => {
		const withBodies = harness("check", () => reply(["network.har", "network-bodies.json"]));
		expect(textOf(await withBodies.run(tmp()))).not.toContain("network-body-har-fetch-check");
		const plain = harness("check", () => reply(["summary.json"]));
		expect(textOf(await plain.run(tmp()))).not.toContain("network-body-har-fetch-check");
	});
});
