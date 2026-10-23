import type { FileDiff } from "./model.ts";

function lineClass(line: string): string {
	if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
	if (line.startsWith("@@")) return "diff-hunk";
	if (line.startsWith("+")) return "diff-add";
	if (line.startsWith("-")) return "diff-del";
	return "diff-context";
}

/** Unified diffs from file edits, one block per file, with added and removed line counts in the header. */
export function DiffView({ diffs }: { diffs: readonly FileDiff[] }) {
	return (
		<div className="diff-view">
			{diffs.map(({ path, type, diff }) => {
				const lines = diff.replace(/\n$/, "").split("\n");
				const added = lines.filter((line) => lineClass(line) === "diff-add").length;
				const removed = lines.filter((line) => lineClass(line) === "diff-del").length;
				return (
					<figure key={path} className="diff-file" aria-label={`${path}: ${added} added, ${removed} removed`}>
						<figcaption className="diff-header">
							<code>{path}</code>
							<span className="muted">{type}</span>
							<span className="diff-stat">
								<span className="diff-add-count">+{added}</span> <span className="diff-del-count">−{removed}</span>
							</span>
						</figcaption>
						<pre className="diff-body">
							{lines.map((line, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and never reorder.
								<span key={index} className={lineClass(line)}>
									{line}
								</span>
							))}
						</pre>
					</figure>
				);
			})}
		</div>
	);
}
