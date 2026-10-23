import type { TelemetryMetrics } from "./metrics.ts";

export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export interface SpanAttributes {
	[name: string]: AttributeValue | undefined;
}

/** Opaque, JSON-serializable adapter-owned propagation data. */
export type TelemetryCarrier = Record<string, string>;

/** Optional transport capability implemented by the application's telemetry adapter. */
export interface TelemetryPropagation {
	inject(context: TelemetryContext): TelemetryCarrier | undefined;
	/** Absent or unknown carriers use the root; recognized identifiers are opaque strings. */
	extract(carrier: TelemetryCarrier | undefined): TelemetryContext;
}

export interface SpanLink {
	context: TelemetryContext;
	attributes?: SpanAttributes;
}

export interface SpanOptions {
	name: string;
	attributes?: SpanAttributes;
	links?: readonly SpanLink[];
}

export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

/** A settled span snapshot, independent of the recording adapter. Event times are relative to span start. */
export interface StoredSpan {
	readonly id: string;
	readonly traceId: string;
	readonly parentId?: string;
	readonly name: string;
	readonly startedMs: number;
	readonly endedMs: number;
	readonly attributes: SpanAttributes;
	readonly events: readonly { readonly name: string; readonly timeMs: number; readonly attributes: SpanAttributes }[];
	readonly links: readonly {
		readonly traceId: string;
		readonly spanId: string;
		readonly attributes?: SpanAttributes;
	}[];
	readonly status: SpanStatus;
}

export interface StoredTrace {
	readonly traceId: string;
	readonly spans: readonly StoredSpan[];
}

export interface TraceQuery {
	/** Name of the earliest stored span, with span ID breaking timestamp ties. */
	readonly name?: string;
	/** All equalities must match one span; that span may be anywhere in the trace. */
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
	readonly errors?: true;
	/** Inclusive bounds on the earliest stored span's start time. */
	readonly startMin?: number;
	readonly startMax?: number;
	/** Positive page size; defaults to 20. */
	readonly limit?: number;
	/** Opaque continuation from the previous page; retain the same filters. */
	readonly cursor?: string;
}

export interface MetricQuery {
	readonly name: string;
	/** Inclusive bounds on interval start time. */
	readonly startMin?: number;
	readonly startMax?: number;
	readonly attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface StoredMetric {
	readonly intervalMs: number;
	readonly name: string;
	readonly kind: "counter" | "upDownCounter" | "histogram";
	readonly unit?: string;
	readonly attributes: SpanAttributes;
	readonly count: number;
	readonly sum: number;
	readonly min: number;
	readonly max: number;
}

/** Read settled traces without depending on a storage backend. */
export interface TelemetryStore {
	findTraces(query?: TraceQuery): Promise<{ traces: readonly StoredTrace[]; cursor?: string }>;
	getTrace(traceId: string): Promise<StoredTrace | undefined>;
	findMetrics(query: MetricQuery): Promise<readonly StoredMetric[]>;
}

/** Adapter contract for trusted typed inputs; malformed input behavior is unspecified. */
export interface TelemetryContext {
	/** Adapter capabilities remain available on child spans and extracted parents. */
	readonly metrics?: TelemetryMetrics;
	readonly propagation?: TelemetryPropagation;
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

export interface TelemetrySpan extends TelemetryContext {
	addLink(link: SpanLink): void;
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}
