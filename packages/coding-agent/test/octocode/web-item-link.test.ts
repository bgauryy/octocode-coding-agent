import type http from "node:http";
import { expect, it, vi } from "vitest";
import { styleBacklogLines } from "../../src/octocode/backlog/tool-style.ts";
import { openDoor, LaunchCodes } from "../../src/octocode/web-daemon/launch-code.ts";
import { linkItem } from "../../src/octocode/shared/render/text.ts";
import {
	itemLinkUrl,
	openItemLink,
	parseItemLink,
	setItemClicksIntercepted,
	setItemLinkHandler,
} from "../../src/octocode/shared/item-ref.ts";
import { daemonOpener } from "../../src/octocode/web-daemon/open.ts";
import { parseWebArgs } from "../../src/octocode/workspace/command.ts";

vi.mock("@octocodeai/octocode-tui", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getCapabilities: () => ({ hyperlinks: true, images: null, trueColor: true }),
}));
vi.mock("../../src/octocode/web-daemon/launcher.ts", () => ({
	ensureWebDaemon: async () => ({ origin: "http://127.0.0.1:7", token: "tok", record: {} }),
	waitForSession: async () => true,
	daemonRequest: async () => ({ status: 200, json: () => ({ code: "one-time" }) }),
}));

const OSC8 = /\u001b\]8;;([^\u001b]*)\u001b\\/g;

function door(query: string): string | undefined {
	const codes = new LaunchCodes();
	const code = codes.issue();
	let location: string | undefined;
	const res = {
		writeHead: (_status: number, headers: Record<string, string>) => {
			location = headers.location;
		},
		end: () => undefined,
	} as unknown as http.ServerResponse;
	openDoor(new URL(`http://127.0.0.1/open/${code}?${query}`), codes, "launch-token", res, () => undefined);
	return location;
}

it("carries an item ref through the launch door into the fragment", () => {
	const target = new URL(door("s=s1&view=board&item=B12")!, "http://127.0.0.1");
	const fragment = new URLSearchParams(target.hash.slice(1));
	expect(fragment.get("item")).toBe("B12");
	expect(fragment.get("access")).toBe("launch-token");
});

it("drops an item that is not a backlog ref", () => {
	for (const item of ["b12", "B12/edit", "../x", "B", "B1234567890"]) {
		const target = new URL(door(`view=board&item=${encodeURIComponent(item)}`)!, "http://127.0.0.1");
		expect(new URLSearchParams(target.hash.slice(1)).get("item"), item).toBeNull();
	}
});

it("parses /web arguments", () => {
	expect(parseWebArgs("")).toEqual({ view: "activity" });
	expect(parseWebArgs("backlogs")).toEqual({ view: "board" });
	expect(parseWebArgs("item B90")).toEqual({ view: "board", item: "B90" });
	expect(parseWebArgs("item b90")).toEqual({ view: "board", item: "B90" });
	for (const bad of ["item", "item T7", "item B1 B2", "backlogs B1", "nope"])
		expect(parseWebArgs(bad), bad).toBeUndefined();
});

it("opens the item through the daemon with a one-time code and no token", async () => {
	const open = vi.fn(async () => undefined);
	const opener = daemonOpener(
		{ ensure: async () => ({ sessionId: "s1", port: 1, close: async () => undefined }) },
		{ env: { OCTOCODE_WEB_DAEMON: "1", DISPLAY: ":0" }, open },
	);
	const ctx = { hasUI: true, ui: { notify: vi.fn() } } as never;
	expect(await opener(ctx, "board", "B90")).toBe(true);
	const url = new URL(String(open.mock.calls[0]));
	expect(url.pathname).toBe("/open/one-time");
	expect(url.searchParams.get("item")).toBe("B90");
	expect(url.href).not.toContain("tok");
});

it("prints the item address instead of opening a browser over SSH", async () => {
	const open = vi.fn(async () => undefined);
	const notify = vi.fn();
	const opener = daemonOpener(
		{ ensure: async () => ({ sessionId: "s1", port: 1, close: async () => undefined }) },
		{ env: { OCTOCODE_WEB_DAEMON: "1", SSH_CONNECTION: "1 2 3 4" }, open },
	);
	await opener({ hasUI: true, ui: { notify } } as never, "board", "B90");
	expect(open).not.toHaveBeenCalled();
	expect(notify.mock.calls[0]?.[0]).toContain("/open/one-time");
});

it("draws a backlog id as an OSC 8 link, and as plain text without hyperlink support", () => {
	const linked = linkItem("B12", "B12", true);
	expect([...linked.matchAll(OSC8)].map((m) => m[1]).filter(Boolean)).toEqual([itemLinkUrl("B12")]);
	expect(linked.replace(OSC8, "")).toBe("B12");
	expect(linkItem("B12", "B12", false)).toBe("B12");
	expect(linkItem("x", "nope", true)).toBe("x");
});

it("links the id on a backlog result line and leaves the text unchanged", () => {
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
	const text = "B90 [ongoing p1] Clickable ids #web\nT7 [todo] a step";
	const on = styleBacklogLines(theme, text, true);
	expect(on[0]).toContain(itemLinkUrl("B90"));
	expect(on.join("\n").replace(OSC8, "")).toBe(text);
	expect(styleBacklogLines(theme, text, false).join("\n")).toBe(text);
});

it("routes a clicked item link to the handler and any other URL to the fallback", () => {
	const handler = vi.fn();
	const fallback = vi.fn();
	setItemLinkHandler(handler);
	openItemLink(itemLinkUrl("B5"), fallback);
	openItemLink("https://example.com/", fallback);
	setItemLinkHandler(undefined);
	expect(handler).toHaveBeenCalledWith("B5");
	expect(fallback).toHaveBeenCalledOnce();
	expect(fallback).toHaveBeenCalledWith("https://example.com/");
	expect(parseItemLink("http://127.0.0.1/__octocode/item/x")).toBeUndefined();
});

it("draws a link only where fullscreen mode intercepts the click and a handler exists", () => {
	const drawn = () => linkItem("B7", "B7") !== "B7";
	setItemLinkHandler(undefined);
	setItemClicksIntercepted(false);
	expect(drawn(), "regular mode, no handler").toBe(false);
	setItemLinkHandler(() => undefined);
	expect(drawn(), "regular mode: the terminal would open a dead address").toBe(false);
	setItemClicksIntercepted(true);
	expect(drawn(), "fullscreen with a handler").toBe(true);
	setItemLinkHandler(undefined);
	expect(drawn(), "fullscreen without a handler").toBe(false);
	setItemClicksIntercepted(false);
});
