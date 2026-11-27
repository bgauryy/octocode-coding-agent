import type { FileDiff } from "./model.ts";

function diffLines(diff: string) {
	let inHunk = false;
	return diff
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => {
			let className = "diff-context";
			if (line.startsWith("@@")) {
				inHunk = true;
				className = "diff-hunk";
			} else if (line.startsWith("diff --git ")) {
				inHunk = false;
				className = "diff-meta";
			} else if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) className = "diff-meta";
			else if (line.startsWith("+")) className = "diff-add";
			else if (line.startsWith("-")) className = "diff-del";
			return { line, className };
		});
}

/** Unified diffs from file edits, one block per file, with added and removed line counts in the header. */
export function DiffView({ diffs }: { diffs: readonly FileDiff[] }) {
	return (
		<div className="diff-view">
			{diffs.map(({ path, type, diff }, fileIndex) => {
				const lines = diffLines(diff);
				const added = lines.filter(({ className }) => className === "diff-add").length;
				const removed = lines.filter(({ className }) => className === "diff-del").length;
				return (
					<figure
						// oxlint-disable-next-line react/no-array-index-key -- ordered tool outcomes may edit the same path more than once.
						key={`${path}:${fileIndex}`}
						className="diff-file"
						aria-label={`${path}: ${added} added, ${removed} removed`}
					>
						<figcaption className="diff-header">
							<code>{path}</code>
							<span className="muted">{type}</span>
							<span className="diff-stat">
								<span className="diff-add-count">+{added}</span> <span className="diff-del-count">−{removed}</span>
							</span>
						</figcaption>
						<pre className="diff-body">
							{lines.map(({ line, className }, index) => (
								// oxlint-disable-next-line react/no-array-index-key -- diff lines are positional and never reorder.
								<span key={index} className={className}>
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
