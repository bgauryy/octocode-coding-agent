import { afterEach, describe, expect, it } from "vitest";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { normalizeApplicationMessage } from "../src/core/application/normalize.ts";

const stores: ApplicationAssets[] = [];
afterEach(() => {
	for (const store of stores) store.clear();
	stores.length = 0;
});
function store(memory = false): ApplicationAssets {
	const value = new ApplicationAssets({ memory });
	stores.push(value);
	return value;
}

describe("session application assets", () => {
	it("retrieves exact binary and unicode text data, deduplicates and rejects arbitrary paths", () => {
		const assets = store();
		const binary = Buffer.from([0, 255, 10, 20]).toString("base64");
		const image = assets.upload({ mimeType: "image/png", data: binary, name: "image.png" });
		expect(assets.get(image.id)).toEqual({ asset: image, encoding: "base64", data: binary });
		expect(assets.upload({ mimeType: "image/png", data: binary }).id).toBe(image.id);
		const text = "שלום\n日本語\n".repeat(1000);
		const full = assets.put(text, "text/plain");
		expect(full.size).toBe(Buffer.byteLength(text));
		expect(assets.get(full.id)?.data).toBe(text);
		expect(assets.get("../../etc/passwd")).toBeUndefined();
		assets.clear();
		expect(assets.get(image.id)).toBeUndefined();
	});
	it("replaces streaming slots and seals final content as immutable assets", () => {
		const assets = store(true);
		const first = assets.put("partial", "text/plain", "utf8", undefined, "message:block");
		const next = assets.put("partial plus more", "text/plain", "utf8", undefined, "message:block");
		expect(next.id).toBe(first.id);
		expect(next.revision).not.toBe(first.revision);
		expect(assets.get(first.id)?.data).toBe("partial plus more");
		const final = assets.put("partial plus more", "text/plain");
		assets.put("another value", "text/plain", "utf8", undefined, "message:block");
		expect(assets.get(final.id)?.data).toBe("partial plus more");
		expect(final.revision).toBeUndefined();
	});
	it("rejects invalid or active image formats and oversized payloads", () => {
		const assets = store(true);
		for (const data of ["", "!!!=", "YQ=", "YW=J", "YQ==anything", "YR=="])
			expect(() => assets.upload({ mimeType: "image/png", data })).toThrow();
		expect(() => assets.upload({ mimeType: "image/svg+xml", data: "PHN2Zy8+" })).toThrow(/PNG/);
		expect(() => assets.upload({ mimeType: "image/png", data: "A".repeat(28 * 1024 * 1024) })).toThrow(/20 MiB/);
		expect(() => assets.put("a".repeat(33 * 1024 * 1024), "text/plain")).toThrow(/32 MiB/);
	});
	it("keeps assets isolated between sessions even when content IDs match", () => {
		const first = store();
		const second = store();
		const asset = first.put("only first session", "text/plain");
		expect(second.get(asset.id)).toBeUndefined();
		const shared = second.put("only first session", "text/plain");
		first.clear();
		expect(second.get(shared.id)?.data).toBe("only first session");
	});
	it("reuses binary streaming slots instead of retaining every cumulative audio or image payload", () => {
		const assets = store(true);
		for (const type of ["image", "media"] as const) {
			const normalize = (data: string, stopReason: string) =>
				normalizeApplicationMessage(
					{
						role: "assistant",
						stopReason,
						content: [{ type, mimeType: type === "image" ? "image/png" : "audio/wav", data }],
					},
					type,
					assets,
				).content![0];
			const first = normalize("YQ==", "pending");
			const second = normalize("YWI=", "pending");
			const final = normalize("YWI=", "stop");
			if (!("asset" in first) || !("asset" in second) || !("asset" in final)) throw new Error("Missing binary block");
			expect(second.asset?.id).toBe(first.asset?.id);
			expect(second.asset?.revision).not.toBe(first.asset?.revision);
			expect(final.asset?.id).not.toBe(first.asset?.id);
			expect(assets.get(second.asset!.id)?.data).toBe("YWI=");
		}
	});
});
