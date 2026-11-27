// MESSAGE RENDERING
// ============================================================

function formatTokens(count) {
	if (count < 1000) return count.toString();
	if (count < 10000) return (count / 1000).toFixed(1) + "k";
	if (count < 1000000) return Math.round(count / 1000) + "k";
	return (count / 1000000).toFixed(1) + "M";
}

function formatTimestamp(ts) {
	if (!ts) return "";
	const date = new Date(ts);
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function replaceTabs(text) {
	return text.replace(/\t/g, "   ");
}

/** Safely coerce value to string for display. Returns null if invalid type. */
function str(value) {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function findToolResult(toolCallId) {
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "toolResult") {
			if (entry.message.toolCallId === toolCallId) {
				return entry.message;
			}
		}
	}
	return null;
}

function formatExpandableOutput(rawText, maxLines, lang) {
	const text = replaceTabs(rawText);
	const lines = text.split("\n");
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;

	if (lang) {
		let highlighted;
		try {
			highlighted = hljs.highlight(text, { language: lang }).value;
		} catch {
			highlighted = escapeHtml(text);
		}

		if (remaining > 0) {
			const previewCode = displayLines.join("\n");
			let previewHighlighted;
			try {
				previewHighlighted = hljs.highlight(previewCode, { language: lang }).value;
			} catch {
				previewHighlighted = escapeHtml(previewCode);
			}

			return `<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
              <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
              <div class="expand-hint">... (${remaining} more lines)</div></div>
              <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
		}

		return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
	}

	// Plain text output
	if (remaining > 0) {
		let out =
			'<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle(\'expanded\')">';
		out += '<div class="output-preview">';
		for (const line of displayLines) {
			out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
		}
		out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
		out += '<div class="output-full">';
		for (const line of lines) {
			out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
		}
		out += "</div></div>";
		return out;
	}

	let out = '<div class="tool-output">';
	for (const line of displayLines) {
		out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
	}
	out += "</div>";
	return out;
}

function renderToolCall(call) {
	const result = findToolResult(call.id);
	const isError = result?.isError || false;
	const statusClass = result ? (isError ? "error" : "success") : "pending";

	const getResultText = () => {
		if (!result) return "";
		const textBlocks = result.content.filter((c) => c.type === "text");
		return textBlocks.map((c) => c.text).join("\n");
	};

	// Calls this tool made to other tools (for example from another tool), recorded without results.
	const renderNestedCalls = () => {
		const nested = result?.nestedCalls;
		if (!nested || !Array.isArray(nested.calls) || nested.calls.length === 0) return "";
		const icons = { ok: "✓", error: "✗", unfinished: "…" };
		const lines = nested.calls.map((c) => {
			const args = c.arguments ? JSON.stringify(c.arguments) : `[arguments omitted, ${c.argumentsBytes} bytes]`;
			const duration = c.durationMs !== undefined ? ` ${c.durationMs}ms` : "";
			const error = c.error ? `\n    ${c.error.split("\n").join("\n    ")}` : "";
			return `${icons[c.status] || "?"} ${c.name} ${args}${duration}${error}`;
		});
		const title = `Nested calls: ${nested.calls.length}${nested.complete ? "" : " (incomplete record)"}`;
		return formatExpandableOutput([title, ...lines].join("\n"), 1);
	};

	const toolDomId = `tool-call-${escapeHtml(call.id)}`;
	let html = `<div class="tool-execution ${statusClass}" id="${toolDomId}">`;
	const args = call.arguments || {};
	const name = call.name;

	const invalidArg = '<span class="tool-error">[invalid arg]</span>';

	// A call the host drew from its display is shown as drawn; the cases below cover calls without one.
	switch (renderedTools?.[call.id] ? "" : name) {
		case "bash": {
			const command = str(args.command);
			const cmdDisplay = command === null ? invalidArg : escapeHtml(command || "...");
			html += `<div class="tool-command">$ ${cmdDisplay}</div>`;
			const reason = str(args.reason);
			// As in the terminal, a reason of one word (a bare `Edit`) says no more than the title.
			if (reason && reason.trim().split(/\s+/).length >= 2)
				html += `<div class="tool-reason">↳ ${escapeHtml(reason.trim())}</div>`;
			if (result) {
				const output = getResultText().trim();
				if (output) html += formatExpandableOutput(output, 5);
			}
			break;
		}
		default: {
			// Check for pre-rendered custom tool HTML
			const rendered = renderedTools?.[call.id];
			if (rendered?.callHtml || rendered?.resultHtmlCollapsed || rendered?.resultHtmlExpanded) {
				// Custom tool with pre-rendered HTML from TUI renderer
				if (rendered.callHtml) {
					html += `<div class="tool-header ansi-rendered">${rendered.callHtml}</div>`;
				} else {
					html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
				}

				if (
					rendered.resultHtmlCollapsed &&
					rendered.resultHtmlExpanded &&
					rendered.resultHtmlCollapsed !== rendered.resultHtmlExpanded
				) {
					// Both collapsed and expanded differ - render expandable section
					html += `<div class="tool-output expandable ansi-rendered" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                  <div class="output-preview">${rendered.resultHtmlCollapsed}</div>
                  <div class="output-full">${rendered.resultHtmlExpanded}</div>
                </div>`;
				} else if (rendered.resultHtmlExpanded) {
					// Only expanded exists (or collapsed is identical) - show directly
					html += `<div class="tool-output ansi-rendered">${rendered.resultHtmlExpanded}</div>`;
				} else if (result) {
					// No pre-rendered result HTML - fallback to JSON
					const output = getResultText();
					if (output) html += formatExpandableOutput(output, 10);
				}
			} else {
				// Fallback to JSON display (existing behavior)
				html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
				html += `<div class="tool-output"><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;
				if (result) {
					const output = getResultText();
					if (output) html += formatExpandableOutput(output, 10);
				}
			}
		}
	}

	html += renderNestedCalls();
	html += "</div>";
	return html;
}

/**
 * Download the session data as a JSONL file.
 * Reconstructs the original format: header line + entry lines.
 */
window.downloadSessionJson = function () {
	// Build JSONL content: header first, then all entries
	const lines = [];
	if (header) {
		lines.push(JSON.stringify({ type: "header", ...header }));
	}
	for (const entry of entries) {
		lines.push(JSON.stringify(entry));
	}
	const jsonlContent = lines.join("\n");

	// Create download
	const blob = new Blob([jsonlContent], { type: "application/x-ndjson" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${header?.id || "session"}.jsonl`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
};
