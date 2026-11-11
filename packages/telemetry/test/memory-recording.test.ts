import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	type SpanAttributes,
	type TelemetrySpan,
} from "../src/index.ts";

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
				// oxlint-disable-next-line typescript/only-throw-error -- a non-Error rejection value is what this test records
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

		const spans = telemetry.getSpans();
		expect(spans.map((span) => span.name)).toEqual(["root-a", "child", "grandchild", "root-b"]);
		const [rootA, child, grandchild, rootB] = spans;
		expect(rootA.parentId).toBeNull();
		expect(child.parentId).toBe(rootA.id);
		expect(grandchild.parentId).toBe(child.id);
		expect(`${grandchild.context["octocode-memory-scope"]}:${grandchild.context["octocode-memory-span"]}`).toBe(
			ids.grandchild,
		);
		const trace = (span: (typeof spans)[number]) => span.context["octocode-memory-trace"];
		expect([child, grandchild].map(trace)).toEqual([ids.rootA, ids.rootA]);
		expect(trace(rootA)).toBe(ids.rootA);
		expect(trace(rootB)).toBe(ids.rootB);
		expect(rootB.parentId).toBeNull();
	});

	it("open spans are recorded by getSpans and marked settled once their callback settles", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = telemetry.startSpan({ name: "open" }, async () => {
			await gate;
		});
		await Promise.resolve();
		expect(telemetry.getSpans().map((span) => [span.name, span.settled])).toEqual([["open", false]]);
		release();
		await running;
		expect(telemetry.getSpans().map((span) => [span.name, span.settled])).toEqual([["open", true]]);
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
