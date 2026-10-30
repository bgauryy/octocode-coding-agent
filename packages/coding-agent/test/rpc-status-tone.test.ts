import { describe, expect, it } from "vitest";
import { createExtensionUIContext } from "../src/modes/rpc/rpc-mode/ui-context.ts";
import type { RpcExtensionUIRequest } from "../src/modes/rpc/rpc-types.ts";

describe("setStatus over RPC", () => {
	it("sends the tone as data beside the plain text, and no tone field when none was given", () => {
		const requests: RpcExtensionUIRequest[] = [];
		const ui = createExtensionUIContext((value) => {
			if ("type" in value && value.type === "extension_ui_request") requests.push(value);
		}, new Map());
		ui.setStatus("jobs", "2 bash jobs", "accent");
		ui.setStatus("lint", "lint ok");
		expect(requests).toMatchObject([
			{ method: "setStatus", statusKey: "jobs", statusText: "2 bash jobs", statusTone: "accent" },
			{ method: "setStatus", statusKey: "lint", statusText: "lint ok" },
		]);
		expect(requests[1]).not.toHaveProperty("statusTone");
	});
});
