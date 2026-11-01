import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	type SpanAttributes,
	type TelemetrySpan,
} from "../src/index.ts";
import { renderTrace } from "../src/render.ts";

afterEach(() => vi.restoreAllMocks());

function spanId(telemetry: InMemoryTelemetryContext, span: TelemetrySpan): string {
	const carrier = telemetry.inject(span)!;
	return `${carrier["octocode-memory-scope"]}:${carrier["octocode-memory-span"]}`;
}

describe("InMemoryTelemetryContext recording copies caller input", () => {
	it("start, setAttributes and addEvent attributes do not alias caller objects or arrays", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const startTags = ["a"];
		const startAttributes: SpanAttributes = { tags: startTags, kind: "start" };
		const endSizes = [1];
		const endAttributes: SpanAttributes = { sizes: endSizes };
		const eventFlags = [true];
		const eventAttributes: SpanAttributes = { flags: eventFlags };

		await telemetry.startSpan({ name: "copy", attributes: startAttributes }, (span) => {
			startTags.push("mutated-during");
			startAttributes.kind = "changed";
			span.setAttributes(endAttributes);
			span.addEvent("event", eventAttributes);
			endSizes.push(2);
			eventFlags.push(false);
			eventAttributes.extra = "late";
		});
		endAttributes.sizes = [9];

		const [recorded] = telemetry.getSpans();
		expect(recorded?.attributes).toEqual({ tags: ["a"], kind: "start", sizes: [1] });
		expect(recorded?.events).toEqual([{ name: "event", attributes: { flags: [true] } }]);
	});

	it("link attributes and status error objects are copied when recorded", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let target!: TelemetrySpan;
		await telemetry.startSpan({ name: "target" }, (span) => {
			target = span;
		});
		const linkAttributes: SpanAttributes = { reason: "original" };
		const error = { name: "Expected", message: "original" };
		await telemetry.startSpan({ name: "source" }, (span) => {
			span.addLink({ context: target, attributes: linkAttributes });
			span.setStatus({ status: "error", error });
		});
		linkAttributes.reason = "changed";
		error.message = "changed";

		const source = telemetry.getSpans().find((span) => span.name === "source")!;
		expect(source.links[0]?.attributes).toEqual({ reason: "original" });
		expect(source.status).toEqual({ status: "error", error: { name: "Expected", message: "original" } });
	});

	it("getSpans snapshots do not alias carriers, so mutating one does not change inject or later snapshots", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let captured!: TelemetrySpan;
		await telemetry.startSpan({ name: "root" }, (span) => {
			captured = span;
		});
		const snapshot = telemetry.getSpans()[0];
		const original = { ...snapshot.context };
		(snapshot.context as Record<string, string>)["octocode-memory-span"] = "999";
		expect(telemetry.getSpans()[0]?.context).toEqual(original);
		expect(telemetry.inject(captured)).toEqual(original);
	});

	it("links to contexts with no recorder carrier are dropped while spans of another recorder are linked", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const foreign = new InMemoryTelemetryContext();
		let foreignSpan!: TelemetrySpan;
		await foreign.startSpan({ name: "foreign" }, (span) => {
			foreignSpan = span;
		});
		const unknown = { startSpan: telemetry.startSpan.bind(telemetry) };
		await telemetry.startSpan({ name: "source", links: [{ context: unknown }] }, (span) => {
			span.addLink({ context: foreignSpan });
		});
		const source = telemetry.getSpans()[0];
		expect(source.links).toHaveLength(1);
		expect(source.links[0]?.context["octocode-memory-trace"]).toBe(
			foreign.getSpans()[0]?.context["octocode-memory-trace"],
		);
	});
});

describe("InMemoryTelemetryContext span behavior", () => {
	it("thrown Error records its name and message; non-Error throws record error without details", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await expect(
			telemetry.startSpan({ name: "typed" }, () => {
				throw new TypeError("bad input");
			}),
		).rejects.toThrow("bad input");
		await expect(
			telemetry.startSpan({ name: "plain" }, () => {
				throw "text";
			}),
		).rejects.toBe("text");

		const spans = telemetry.getSpans();
		expect(spans.find((span) => span.name === "typed")?.status).toEqual({
			status: "error",
			error: { name: "TypeError", message: "bad input" },
		});
		expect(spans.find((span) => span.name === "plain")?.status).toEqual({ status: "error" });
	});

	it("an error thrown from a child marks the child and, when rethrown, the parent; a caught child error leaves the parent ok", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "survivor" }, async (span) => {
			await span
				.startSpan({ name: "caught-child" }, () => {
					throw new Error("handled");
				})
				.catch(() => undefined);
		});
		await expect(
			telemetry.startSpan({ name: "failing" }, (span) =>
				span.startSpan({ name: "propagated-child" }, () => {
					throw new RangeError("escaped");
				}),
			),
		).rejects.toBeInstanceOf(RangeError);

		const status = (name: string) => telemetry.getSpans().find((span) => span.name === name)?.status.status;
		expect(status("caught-child")).toBe("error");
		expect(status("survivor")).toBe("ok");
		expect(status("propagated-child")).toBe("error");
		expect(status("failing")).toBe("error");
	});

	it("nested spans share the root's trace and separate roots start separate traces", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const ids: Record<string, string> = {};
		await telemetry.startSpan({ name: "root-a" }, async (root) => {
			ids.rootA = spanId(telemetry, root);
			await root.startSpan({ name: "child" }, (child) =>
				child.startSpan({ name: "grandchild" }, (grandchild) => {
					ids.grandchild = spanId(telemetry, grandchild);
				}),
			);
		});
		await telemetry.startSpan({ name: "root-b" }, (root) => {
			ids.rootB = spanId(telemetry, root);
		});

		const traceA = await telemetry.getTrace(ids.rootA);
		expect(traceA?.spans.map((span) => span.name)).toEqual(["root-a", "child", "grandchild"]);
		const [rootA, child, grandchild] = traceA!.spans;
		expect(rootA.parentId).toBeUndefined();
		expect(child.parentId).toBe(rootA.id);
		expect(grandchild.parentId).toBe(child.id);
		expect(grandchild.id).toBe(ids.grandchild);
		expect((await telemetry.getTrace(ids.rootB))?.spans.map((span) => span.name)).toEqual(["root-b"]);
		expect(await telemetry.getTrace("missing:1")).toBeUndefined();
	});

	it("open spans are recorded by getSpans but hidden from store queries until they settle", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let id = "";
		const running = telemetry.startSpan({ name: "open" }, async (span) => {
			id = spanId(telemetry, span);
			await gate;
		});
		await Promise.resolve();
		expect(telemetry.getSpans().map((span) => [span.name, span.settled])).toEqual([["open", false]]);
		expect(await telemetry.getTrace(id)).toBeUndefined();
		expect((await telemetry.findTraces()).traces).toEqual([]);
		release();
		await running;
		expect((await telemetry.getTrace(id))?.spans).toHaveLength(1);
	});

	it("findTraces defaults to 20 traces per page, newest first, and returns a cursor only when more remain", async () => {
		const now = vi.spyOn(Date, "now");
		const telemetry = new InMemoryTelemetryContext();
		for (let index = 0; index < 21; index++) {
			now.mockReturnValue(1000 + index);
			await telemetry.startSpan({ name: `trace-${index}` }, () => {});
		}
		const first = await telemetry.findTraces();
		expect(first.traces).toHaveLength(20);
		expect(first.traces[0]?.spans[0]?.name).toBe("trace-20");
		expect(first.cursor).toBeDefined();
		const second = await telemetry.findTraces({ cursor: first.cursor });
		expect(second.traces.map((trace) => trace.spans[0]?.name)).toEqual(["trace-0"]);
		expect(second.cursor).toBeUndefined();
	});
});

describe("createTypedSpanStarter at runtime", () => {
	const schema = defineTelemetrySchema({
		version: 1,
		spans: {
			job: {
				description: "Job",
				parents: { kind: "any" },
				startAttributes: {
					kind: { type: "string", required: true, values: ["a", "b"], description: "Kind" },
					size: { type: "number", required: false, description: "Size" },
				},
				endAttributes: { outcome: { type: "string", description: "Outcome" } },
				events: {
					step: {
						description: "Step",
						attributes: { index: { type: "number", required: true, description: "Index" } },
					},
				},
				status: { default: "ok", errorWhen: "The job fails" },
			},
		},
	} as const);

	it("records the schema span name, start attributes, end attributes and events on the bound context", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const start = createTypedSpanStarter(telemetry, [schema]);
		await start("job", { kind: "a", size: 3 }, (span) => {
			span.addEvent("step", { index: 1 });
			span.setAttributes({ outcome: "done" });
		});
		const [recorded] = telemetry.getSpans();
		expect(recorded?.name).toBe("job");
		expect(recorded?.attributes).toEqual({ kind: "a", size: 3, outcome: "done" });
		expect(recorded?.events).toEqual([{ name: "step", attributes: { index: 1 } }]);
	});

	it("binds to an explicit parent span so typed roots become children of that span", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "outer" }, (outer) =>
			createTypedSpanStarter(outer, [schema])("job", { kind: "b" }, () => undefined),
		);
		const outer = telemetry.getSpans().find((span) => span.name === "outer")!;
		const job = telemetry.getSpans().find((span) => span.name === "job")!;
		expect(job.parentId).toBe(outer.id);
	});

	it("performs no runtime validation: attributes outside the schema are passed through as given", async () => {
		// The schema is documented as type-only; this pins that the runtime neither drops nor rejects values.
		const telemetry = new InMemoryTelemetryContext();
		const start = createTypedSpanStarter(telemetry, [schema]) as unknown as (
			name: string,
			attributes: SpanAttributes,
			callback: () => void,
		) => Promise<void>;
		await expect(start("job", { kind: "not-in-values", undeclared: true }, () => {})).resolves.toBeUndefined();
		expect(telemetry.getSpans()[0]?.attributes).toEqual({ kind: "not-in-values", undeclared: true });
	});
});

describe("render subpath", () => {
	it("package export ./render points at the module that defines renderTrace", async () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, { source?: string; import?: string; types?: string }>;
		};
		const entry = manifest.exports["./render"];
		expect(entry?.source).toBe("./src/render.ts");
		expect(entry?.import).toBe("./dist/render.js");
		const module = (await import(new URL(`../${entry.source}`, import.meta.url).href)) as Record<string, unknown>;
		expect(module.renderTrace).toBe(renderTrace);
	});

	it("renders a trace read back from the in-memory store as an indented tree with errors and events", async () => {
		vi.spyOn(Date, "now").mockReturnValue(5000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const telemetry = new InMemoryTelemetryContext();
		let rootId = "";
		await telemetry.startSpan({ name: "request", attributes: { route: "/x" } }, async (root) => {
			rootId = spanId(telemetry, root);
			clock.mockReturnValue(2);
			root.addEvent("received", { bytes: 3 });
			await root
				.startSpan({ name: "db" }, () => {
					clock.mockReturnValue(7);
					throw new Error("timeout");
				})
				.catch(() => undefined);
			clock.mockReturnValue(10);
		});
		const trace = await telemetry.getTrace(rootId);
		expect(renderTrace(trace!.spans)).toBe(
			['request route="/x" (10ms)', "  · received bytes=3 (+2ms)", "  db (5ms) error Error: timeout"].join("\n"),
		);
	});
});
