import type { ApplicationTool } from "@octocodeai/octocode-contracts";

/** What the model sent and got back, as recorded: one folded section, apart from how the call reads. */
export function RawToolData({ tool, args }: { tool?: ApplicationTool; args?: unknown }) {
	const input = tool?.arguments ?? args;
	if (
		input === undefined &&
		tool?.structuredContent === undefined &&
		tool?.details === undefined &&
		tool?.usage === undefined
	)
		return null;
	return (
		<details className="result-details">
			<summary>Raw data</summary>
			{input !== undefined && <JsonDetails label="Arguments" value={input} />}
			{tool?.structuredContent !== undefined && (
				<JsonDetails label="Structured result" value={tool.structuredContent} />
			)}
			{tool?.details !== undefined && <JsonDetails label="Result details" value={tool.details} />}
			{tool?.usage !== undefined && <JsonDetails label="Tool usage" value={tool.usage} />}
		</details>
	);
}

export function ToolReason({ reason }: { reason: string }) {
	return reason ? <p className="tool-reason">↳ {reason}</p> : null;
}

export function JsonDetails({ label, value }: { label: string; value: unknown }) {
	return (
		<details className="result-details">
			<summary>{label}</summary>
			<pre>{JSON.stringify(value, null, 2)}</pre>
		</details>
	);
}
