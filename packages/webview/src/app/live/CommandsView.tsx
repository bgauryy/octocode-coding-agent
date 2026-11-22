import { useEffect, useRef, useState } from "react";
import {
	TERMINAL_COMMAND_ROUTE,
	type TerminalCommandRequest,
	type TerminalCommandResult,
} from "@octocodeai/octocode-contracts/protocol";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { bearer, takeAccess } from "../../access.ts";
import { requestJson } from "../../request.ts";
import { scopedRoute } from "../../scope.ts";
import { Field, SearchField } from "../ui/fields.tsx";
import { LongText } from "../ui/LongText.tsx";
import { Button } from "../ui/primitives.tsx";

type Catalog = Extract<TerminalCommandResult, { commands: unknown }>;
type Receipt = Exclude<TerminalCommandResult, Catalog>;
type Input = Extract<TerminalCommandRequest, { action: "input" }>;
const KEYS = [
	["up", "↑"],
	["down", "↓"],
	["left", "←"],
	["right", "→"],
	["tab", "Tab"],
	["backspace", "Backspace"],
	["enter", "Enter"],
	["escape", "Esc"],
] as const;
function send(request: TerminalCommandRequest, signal?: AbortSignal) {
	return requestJson<Receipt>(scopedRoute(TERMINAL_COMMAND_ROUTE), {
		method: "POST",
		signal,
		headers: { ...bearer(takeAccess()), "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
}
export function CommandsView() {
	const [catalog, setCatalog] = useState<Catalog>();
	const [query, setQuery] = useState("");
	const [choice, setChoice] = useState("");
	const [args, setArgs] = useState("");
	const [answer, setAnswer] = useState("");
	const [run, setRun] = useState<Receipt>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [revision, setRevision] = useState(0);
	const resultHeading = useRef<HTMLHeadingElement>(null);
	const focusResult = useRef(false);
	const sending = useRef(false);
	const latest = useRef(0);
	useEffect(() => {
		const controller = new AbortController();
		async function load() {
			const next = await requestJson<Catalog>(scopedRoute(TERMINAL_COMMAND_ROUTE), {
				headers: bearer(takeAccess()),
				signal: controller.signal,
			});
			setCatalog(next);
			setRun(
				next.activeId
					? await send({ action: "status", sessionId: next.sessionId, id: next.activeId }, controller.signal)
					: undefined,
			);
		}
		void load().catch((cause: unknown) => {
			if (!controller.signal.aborted) setError(errorMessage(cause));
		});
		return () => controller.abort();
	}, [revision]);
	const sessionId = catalog?.sessionId;
	const running = run?.phase === "running" || run?.phase === "dialog";
	const id = run?.id;
	const phase = run?.phase;
	useEffect(() => {
		if (focusResult.current && phase && phase !== "running") {
			focusResult.current = false;
			resultHeading.current?.focus();
		}
	}, [id, phase]);
	useEffect(() => {
		if (!running || !id || !sessionId) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			const version = latest.current;
			try {
				if (!sending.current) {
					const value = await send({ action: "status", id: id!, sessionId: sessionId! }, controller.signal);
					if (!controller.signal.aborted && version === latest.current) setRun(value);
				}
			} catch (cause) {
				if (!controller.signal.aborted) setError(errorMessage(cause));
				return;
			}
			if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 800);
		}
		timer = setTimeout(() => void poll(), 800);
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [running, id, sessionId, revision]);
	const term = query.trim().replace(/^\//, "").toLowerCase();
	const commands =
		catalog?.commands.filter((command) =>
			[command.name, command.description, ...(command.aliases ?? [])].some((field) =>
				field?.toLowerCase().includes(term),
			),
		) ?? [];
	const selected = commands.find((command) => command.name === choice) ?? commands[0];
	const invocation = selected?.aliases?.find((alias) => alias.toLowerCase() === term) ?? selected?.name;
	async function act(request: TerminalCommandRequest) {
		if (sending.current) return;
		sending.current = true;
		latest.current++;
		setBusy(true);
		setError("");
		try {
			const response = await send(request);
			if (request.action === "run") focusResult.current = true;
			setRun(response);
			setAnswer("");
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			sending.current = false;
			setBusy(false);
		}
	}
	function key(value: Input["key"]) {
		if (sessionId && run?.dialog)
			void act({
				action: "input",
				sessionId,
				id: run.id,
				dialog: run.dialog,
				sequence: run.sequence + 1,
				key: value,
				...(value === "text" ? { text: answer } : {}),
			});
	}
	return (
		<div className="view commands-view">
			<div className="view-heading">
				<h2>Session commands</h2>
			</div>
			{error && (
				<div role="alert">
					{error}{" "}
					<Button
						size="sm"
						onClick={() => {
							setError("");
							setRevision((n) => n + 1);
						}}
					>
						Refresh
					</Button>
				</div>
			)}
			{!catalog && !error && <output>Loading commands…</output>}
			{catalog && !run?.dialog && (
				<form
					className="panel command-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (invocation && !running && !error)
							void act({
								action: "run",
								sessionId: catalog.sessionId,
								id: crypto.randomUUID(),
								name: invocation,
								args,
							});
					}}
				>
					<SearchField
						data-search=""
						label="Search slash commands"
						placeholder="Search slash commands"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setArgs("");
						}}
					/>
					{selected ? (
						<>
							<Field label="Command">
								{(props) => (
									<select
										{...props}
										size={6}
										value={selected.name}
										onChange={(event) => {
											setChoice(event.target.value);
											setArgs("");
										}}
									>
										{commands.map((command) => (
											<option key={command.name} value={command.name}>
												/{command.name}
											</option>
										))}
									</select>
								)}
							</Field>
							<p>{selected.description}</p>
							<Field label={`Arguments for /${invocation}`}>
								{(props) => (
									<input
										{...props}
										value={args}
										placeholder={selected.argumentHint}
										maxLength={16000}
										onChange={(event) => setArgs(event.target.value)}
									/>
								)}
							</Field>
							<Button type="submit" disabled={busy || running || Boolean(error)}>
								Run /{invocation}
							</Button>
						</>
					) : (
						<p>No matching commands.</p>
					)}
				</form>
			)}
			{run && (
				<section className="panel command-form" aria-label="Command result">
					<h3 ref={resultHeading} tabIndex={-1}>
						{run.phase === "dialog"
							? "Command dialog"
							: run.phase === "running"
								? "Running command"
								: run.phase === "failed"
									? "Command failed"
									: "Command result"}{" "}
						/{run.name}
					</h3>
					{run.text &&
						(run.dialog ? (
							<pre className="text output command-output">{run.text}</pre>
						) : (
							<LongText key={run.id} text={run.text} label="Command output" plain />
						))}
					{!run.text && (
						<output>
							{running
								? "Waiting for the session. Check Activity for a question or approval."
								: "The command returned."}
						</output>
					)}
					{run.dialog && (
						<>
							<div className="view-actions">
								{KEYS.map(([value, label]) => (
									<Button size="sm" key={value} disabled={busy} onClick={() => key(value)}>
										{label}
									</Button>
								))}
							</div>
							<form
								className="command-answer"
								onSubmit={(event) => {
									event.preventDefault();
									key("text");
								}}
							>
								<Field label="Type into the dialog">
									{(props) => (
										<input
											{...props}
											value={answer}
											maxLength={4000}
											onChange={(event) => setAnswer(event.target.value)}
										/>
									)}
								</Field>
								<Button type="submit" disabled={!answer || busy}>
									Type text
								</Button>
							</form>
						</>
					)}
				</section>
			)}
		</div>
	);
}
