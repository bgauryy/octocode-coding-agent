import type { McpAddCommand, McpAddResult } from "@octocodeai/octocode-contracts/config";
import { useState } from "react";
import { Button } from "../ui/primitives.tsx";

export type AddMcp = (command: McpAddCommand) => Promise<McpAddResult>;

function stringMap(text: string): Record<string, string> {
	const value: unknown = JSON.parse(text || "{}");
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.values(value).some((item) => typeof item !== "string")
	)
		throw new Error("Use a JSON object whose values are strings.");
	return value as Record<string, string>;
}

export function McpAddForm({
	add,
	repoId,
	trusted,
	onCancel,
	onSaved,
}: {
	add: AddMcp;
	repoId?: string;
	trusted: boolean;
	onCancel: () => void;
	onSaved: (result: McpAddResult) => void;
}) {
	const [name, setName] = useState("");
	const [transport, setTransport] = useState<"stdio" | "http">("stdio");
	const [scope, setScope] = useState<"global" | "workspace">("global");
	const [command, setCommand] = useState("");
	const [url, setUrl] = useState("");
	const [args, setArgs] = useState("[]");
	const [env, setEnv] = useState("{}");
	const [headers, setHeaders] = useState("{}");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<form
			aria-label="Add MCP"
			onSubmit={async (event) => {
				event.preventDefault();
				if (pending) return;
				setError(undefined);
				let definition: McpAddCommand;
				try {
					if (!/^[A-Za-z0-9_-]+$/.test(name.trim()) || name.trim().length > 128)
						throw new Error("Use a server name containing letters, digits, underscores or hyphens.");
					if (scope === "workspace" && (!repoId || !trusted)) throw new Error("Choose a trusted workspace first.");
					const common = { name: name.trim(), scope, ...(repoId ? { repoId } : {}) };
					if (transport === "stdio") {
						if (!command.trim()) throw new Error("Command must not be blank.");
						const parsed: unknown = JSON.parse(args || "[]");
						if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string"))
							throw new Error("Arguments must be a JSON array of strings.");
						definition = { ...common, transport, command, args: parsed as string[], env: stringMap(env) };
					} else {
						let parsed: URL;
						try {
							parsed = new URL(url.trim());
						} catch {
							throw new Error("Use an HTTP(S) URL.");
						}
						if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Use an HTTP(S) URL.");
						definition = { ...common, transport, url: url.trim(), headers: stringMap(headers) };
					}
				} catch (cause) {
					setError(
						cause instanceof SyntaxError
							? "Invalid JSON. Use an array of strings for arguments and an object of strings for environment or headers."
							: cause instanceof Error
								? cause.message
								: "Check the definition fields.",
					);
					return;
				}
				setPending(true);
				try {
					onSaved(await add(definition));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : "Could not save the MCP definition.");
				} finally {
					setPending(false);
				}
			}}
		>
			<fieldset disabled={pending}>
				<legend>New MCP definition</legend>
				<label>
					Name
					<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
				</label>
				<label>
					Save to
					<select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
						<option value="global">Global</option>
						<option value="workspace" disabled={!repoId || !trusted}>
							Trusted workspace
						</option>
					</select>
				</label>
				<label>
					Transport
					<select value={transport} onChange={(event) => setTransport(event.target.value as typeof transport)}>
						<option value="stdio">Stdio</option>
						<option value="http">HTTP</option>
					</select>
				</label>
				{transport === "stdio" ? (
					<>
						<label>
							Command
							<input value={command} onChange={(event) => setCommand(event.target.value)} autoComplete="off" />
						</label>
						<p className="muted">Executable name or path, not a shell command line.</p>
						<label>
							Arguments (JSON array)
							<textarea value={args} onChange={(event) => setArgs(event.target.value)} spellCheck={false} />
						</label>
						<label>
							Environment (JSON object)
							<textarea
								value={env}
								onChange={(event) => setEnv(event.target.value)}
								spellCheck={false}
								autoComplete="off"
							/>
						</label>
					</>
				) : (
					<>
						<label>
							HTTP URL
							<input value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" />
						</label>
						<label>
							Headers (JSON object)
							<textarea
								value={headers}
								onChange={(event) => setHeaders(event.target.value)}
								spellCheck={false}
								autoComplete="off"
							/>
						</label>
					</>
				)}
				<p className="muted">
					Environment and headers are saved to disk, not returned by this page. Prefer environment references such as{" "}
					{"${TOKEN}"}. Saving does not connect, sign in or approve the server.
				</p>
				{error && <p role="alert">{error}</p>}
				<Button type="submit">{pending ? "Saving…" : "Save MCP"}</Button>
				<Button type="button" onClick={onCancel}>
					Cancel
				</Button>
			</fieldset>
		</form>
	);
}
