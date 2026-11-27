import { describe, expect, it } from "vitest";
import { mergeScopedSettings } from "../src/core/settings-manager/merge.ts";

describe("remote settings across scopes", () => {
	it("lets a project file turn remote auto-start off, never on", () => {
		expect(mergeScopedSettings({ remote: { autoStart: "control" } }, { remote: { autoStart: "off" } }).remote).toEqual({
			autoStart: "off",
		});
		expect(mergeScopedSettings({ remote: { autoStart: "off" } }, { remote: { autoStart: "control" } }).remote).toEqual({
			autoStart: "off",
		});
		expect(mergeScopedSettings({}, { remote: { autoStart: "view" } }).remote).toEqual({});
		expect(mergeScopedSettings({ remote: { autoStart: "view" } }, {}).remote).toEqual({ autoStart: "view" });
	});

	it("lets a project choose the transport and relay like any other setting", () => {
		expect(
			mergeScopedSettings(
				{ remote: { transport: "ssh", autoStart: "view" } },
				{ remote: { transport: "relay", relayUrl: "wss://relay.example" } },
			).remote,
		).toEqual({ transport: "relay", relayUrl: "wss://relay.example", autoStart: "view" });
	});
});
