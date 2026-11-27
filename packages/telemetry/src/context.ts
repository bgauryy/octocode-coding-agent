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

export interface InstrumentOptions {
	description?: string;
	unit?: string;
}

export interface HistogramOptions extends InstrumentOptions {
	/** Bucket hints; callers supply finite, strictly increasing values. */
	boundaries?: readonly number[];
}

export interface TelemetryCounter {
	add(value: number, attributes?: SpanAttributes): void;
}

export interface TelemetryUpDownCounter {
	add(value: number, attributes?: SpanAttributes): void;
}

export interface TelemetryHistogram {
	record(value: number, attributes?: SpanAttributes, context?: TelemetryContext): void;
}

/**
 * Optional adapter capability with synchronous factories and recording methods.
 * Typed inputs are trusted; callers supply finite measurements and nonnegative counter increments.
 * Malformed input behavior is unspecified.
 */
export interface TelemetryMetrics {
	counter(name: string, options?: InstrumentOptions): TelemetryCounter;
	upDownCounter(name: string, options?: InstrumentOptions): TelemetryUpDownCounter;
	histogram(name: string, options?: HistogramOptions): TelemetryHistogram;
}
