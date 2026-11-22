import { memo, useState } from "react";
import { TextFold } from "../ui/LongText.tsx";
import { useCopy, useElapsed, useStickToBottom } from "../hooks.ts";
import { plural, span } from "../model/format.ts";
import { ArrowDownIcon, CheckIcon, CopyIcon, TerminalIcon, WrapIcon } from "../ui/icons.tsx";
import { Button, cx, Spinner } from "../ui/primitives.tsx";
import type { TerminalEntry } from "./model.ts";

/**
 * Tool calls as a terminal transcript, oldest first, pinned to the newest line while the reader stays at the bottom.
 * Read-only: commands run in the agent's session under the host's permissions, never from this page.
 */
export function TerminalTranscript({ entries }: { entries: readonly TerminalEntry[] }) {
	const { ref: log, atBottom, jump } = useStickToBottom<HTMLOListElement>(entries);
	const [wrap, setWrap] = useState(true);
	const [copied, copy] = useCopy(() =>
		entries.map((entry) => `$ ${entry.command}${entry.output ? `\n${entry.output}` : ""}`).join("\n\n"),
	);
	const running = entries.filter((entry) => entry.status === "running").length;

	return (
		<div className="terminal">
			<div className="terminal-bar">
				<span className="terminal-dots" aria-hidden="true">
					<span />
					<span />
					<span />
				</span>
				<TerminalIcon size={14} />
				<span className="terminal-title">
					{plural(entries.length, "command")}
					{running ? ` · ${running} running` : ""}
				</span>
				<Button
					size="sm"
					variant="ghost"
					icon={<WrapIcon />}
					aria-pressed={wrap}
					onClick={() => setWrap((value) => !value)}
				>
					Wrap lines
				</Button>
				<Button
					size="sm"
					variant="ghost"
					icon={copied === "copied" ? <CheckIcon /> : <CopyIcon />}
					onClick={copy}
					disabled={!entries.length}
				>
					{copied === "copied" ? "Copied" : copied === "failed" ? "Copy unavailable" : "Copy transcript"}
				</Button>
			</div>
			{entries.length ? (
				<ol
					ref={log}
					className={cx("terminal-body", wrap && "is-wrapped")}
					role="log"
					aria-label="Terminal transcript"
					aria-live="off"
				>
					{entries.map((entry) => (
						<TerminalLine key={entry.id} entry={entry} />
					))}
				</ol>
			) : (
				<div className="terminal-body terminal-empty">
					<p>No commands yet</p>
					<p className="terminal-muted">Tool calls from this session appear here as they run.</p>
				</div>
			)}
			{!atBottom && (
				<Button size="sm" variant="primary" className="terminal-jump" icon={<ArrowDownIcon />} onClick={jump}>
					Jump to latest
				</Button>
			)}
		</div>
	);
}

const TerminalLine = memo(function TerminalLine({ entry }: { entry: TerminalEntry }) {
	const running = entry.status === "running";
	const elapsed = useElapsed(entry.at, running);
	return (
		<li className={`terminal-entry status-${entry.status}`}>
			<div className="terminal-prompt">
				<span className="prompt-symbol" aria-hidden="true">
					❯
				</span>
				<span className="terminal-command">{entry.command}</span>
				<span className="terminal-status">
					{running ? <Spinner size={10} /> : null}
					{running ? `running · ${span(elapsed)}` : entry.status}
				</span>
			</div>
			{entry.output && (
				<TextFold text={entry.output} label="Output">
					<pre className="terminal-output">{entry.output}</pre>
				</TextFold>
			)}
		</li>
	);
});
