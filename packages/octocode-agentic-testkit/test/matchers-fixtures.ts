import { Trace, type CapturedRequest, type TraceEvent } from "../src/trace.ts";

type Ev = Omit<TraceEvent, "seq" | "span" | "agent"> & { agent?: string };

export const call = (name: string, args: unknown = {}, agent = "main"): Ev => ({
	kind: "model_tool_call",
	name,
	args,
	agent,
});

export function traceOf(events: Ev[], requests: Partial<CapturedRequest>[] = []): Trace {
	const t = new Trace();
	events.forEach((e) => t.record({ span: "main", agent: "main", ...e }));
	requests.forEach((r, i) =>
		t.requests.push({
			index: i,
			agent: "main",
			span: "main",
			model: "m",
			stream: false,
			messages: [],
			tools: [],
			raw: {},
			canonical: "",
			hash: "",
			bytes: 0,
			...r,
		}),
	);
	return t;
}
