import { describe, expect, it } from "vitest";
import { withCacheFlags } from "../src/utils/cache-capabilities.ts";

describe("withCacheFlags", () => {
	it("lets an unexpected error from the flag table surface", () => {
		const table = {
			get openai(): never {
				throw new Error("table broke");
			},
		};
		const model = { api: "openai-responses", provider: "openai", id: "x", baseUrl: "https://api.openai.com/v1" };
		expect(() => withCacheFlags(model as never, table as never)).toThrow("table broke");
	});
});
