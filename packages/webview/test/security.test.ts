import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { renderBacklogHtml } from "../src/index.ts";
import { offlinePageJs } from "../src/state.generated.ts";

/**
 * The offline export's guarantee: data renders only as text and the page never parses HTML or reaches the network.
 * React DOM ships sink code paths (for `dangerouslySetInnerHTML`) that this page never uses, so the guard is twofold:
 * our own source contains no sink, and the built page, run on hostile data, never touches one.
 */
const SINKS = [
	"innerHTML",
	"outerHTML",
	"insertAdjacentHTML",
	"document.write",
	"eval(",
	"new Function",
	"srcdoc",
	"DOMParser",
	"createContextualFragment",
	"dangerouslySetInnerHTML",
	"javascript:",
];
const XSS = '</script><img src=x onerror="alert(1)"><script>alert(2)</script><iframe srcdoc="x">';

const GENERATED = new Set(["state.generated.ts", "mermaid.generated.ts"]);

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sources(path);
		// The generated page bundle and the vendored Mermaid script are library code; the next tests cover what ships.
		return /\.tsx?$/.test(entry.name) && !GENERATED.has(entry.name) ? [path] : [];
	});
}

const pages: JSDOM[] = [];
afterEach(() => {
	for (const page of pages.splice(0)) page.window.close();
});

describe("offline export security", () => {
	it("keeps every HTML sink out of the renderer's source", () => {
		const root = join(import.meta.dirname, "../src");
		for (const file of sources(root)) {
			const text = readFileSync(file, "utf8");
			for (const sink of SINKS) expect(text, `${file.slice(root.length)} uses ${sink}`).not.toContain(sink);
		}
	});

	it("ships no Mermaid in the offline export, which never loads a diagram renderer", () => {
		expect(offlinePageJs()).not.toMatch(/mermaid/i);
	});

	it("renders hostile data as text in every view without touching a sink or the network", async () => {
		const hits: string[] = [];
		const item = (ref: string, extra: object = {}) => ({
			ref,
			title: `${XSS} ${ref}`,
			goal: XSS,
			body: XSS,
			paths: [XSS],
			why: XSS,
			evidence: [XSS],
			plan: XSS,
			state: "ongoing" as const,
			priority: "p0",
			tags: [XSS],
			assignee: XSS,
			createdBy: XSS,
			createdAt: 0,
			updatedAt: 0,
			version: 1,
			derived: [],
			notes: [{ at: 0, author: XSS, kind: "note" as const, text: XSS }],
			...extra,
		});
		const html = renderBacklogHtml({
			repo: XSS,
			generatedAt: 0,
			states: ["backlog", "todo", "ongoing", "done"],
			idleMs: 1,
			items: [item("B1", { children: ["B2"] }), item("B2", { parentId: "B1", from: "B1" })],
		});
		const errors: string[] = [];
		const virtualConsole = new VirtualConsole();
		virtualConsole.on("jsdomError", (error) => errors.push(error.message));
		virtualConsole.on("error", (message) => errors.push(String(message)));
		const dom = new JSDOM(html, {
			virtualConsole,
			url: "file:///export.html",
			runScripts: "dangerously",
			pretendToBeVisual: true,
			beforeParse(window) {
				const trap = (name: string) =>
					function trapped() {
						hits.push(name);
						throw new Error(`${name} is not allowed`);
					};
				for (const [prototype, property] of [
					[window.Element.prototype, "innerHTML"],
					[window.Element.prototype, "outerHTML"],
					[window.HTMLIFrameElement.prototype, "srcdoc"],
				] as const) {
					const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
					Object.defineProperty(prototype, property, { ...descriptor, set: trap(`${property} =`) });
				}
				window.Element.prototype.insertAdjacentHTML = trap("insertAdjacentHTML");
				window.Range.prototype.createContextualFragment = trap("createContextualFragment");
				// oxlint-disable-next-line typescript/no-deprecated -- the trap proves rendered content never reaches these sinks
				window.document.write = trap("document.write");
				// oxlint-disable-next-line typescript/no-deprecated -- the trap proves rendered content never reaches these sinks
				window.document.writeln = trap("document.writeln");
				for (const name of ["eval", "fetch", "WebSocket", "XMLHttpRequest", "EventSource", "DOMParser"])
					Object.defineProperty(window, name, { value: trap(name), configurable: true });
				Object.defineProperty(window, "Function", {
					value: new Proxy(window.Function, { construct: trap("new Function"), apply: trap("Function()") }),
				});
				Object.defineProperty(window.navigator, "sendBeacon", { value: trap("sendBeacon") });
			},
		});
		pages.push(dom);
		const { document } = dom.window;
		const settle = () => new Promise((resolve) => dom.window.setTimeout(resolve, 20));
		for (const hash of ["#board", "#table", "#tree", "#attention", "#B1", "#B2", "#board?q=img"]) {
			dom.window.location.hash = hash;
			dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
			await settle();
			expect(document.querySelector("body img, body iframe, #app script")).toBeNull();
			if (hash === "#B1") expect(document.querySelector("#item-title")?.textContent).toBe(`${XSS} B1`);
		}
		expect(document.querySelector("h1")?.textContent).toBe(XSS);
		expect(document.title).toBe("Board · Octocode");
		expect(errors).toEqual([]);
		expect(hits).toEqual([]);
	});
});
