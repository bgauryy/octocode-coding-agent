/**
 * Build a shareable URL for a specific message.
 * URL format: base?gistId&leafId=<leafId>&targetId=<entryId>
 */
function buildShareUrl(entryId) {
	// Check for injected base URL (used when loaded in iframe via srcdoc)
	const baseUrlMeta = document.querySelector('meta[name="pi-share-base-url"]');
	const baseUrl = baseUrlMeta ? baseUrlMeta.content : window.location.href.split("?")[0];

	const url = new URL(window.location.href);
	// Find the gist ID (first query param without value, e.g., ?abc123)
	const gistId = Array.from(url.searchParams.keys()).find((k) => !url.searchParams.get(k));

	// Build the share URL
	const params = new URLSearchParams();
	params.set("leafId", currentLeafId);
	params.set("targetId", entryId);

	// If we have an injected base URL (iframe context), use it directly
	if (baseUrlMeta) {
		return `${baseUrl}&${params.toString()}`;
	}

	// Otherwise build from current location (direct file access)
	url.search = gistId ? `?${gistId}&${params.toString()}` : `?${params.toString()}`;
	return url.toString();
}

/**
 * Copy text to clipboard with visual feedback.
 * Uses navigator.clipboard with fallback to execCommand for HTTP contexts.
 */
async function copyToClipboard(text, button) {
	let success = false;
	try {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			await navigator.clipboard.writeText(text);
			success = true;
		}
	} catch (err) {
		// Clipboard API failed, try fallback
	}

	// Fallback for HTTP or when Clipboard API is unavailable
	if (!success) {
		try {
			const textarea = document.createElement("textarea");
			textarea.value = text;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			success = document.execCommand("copy");
			document.body.removeChild(textarea);
		} catch (err) {
			console.error("Failed to copy:", err);
		}
	}

	if (success && button) {
		const originalHtml = button.innerHTML;
		button.innerHTML = "✓";
		button.classList.add("copied");
		setTimeout(() => {
			button.innerHTML = originalHtml;
			button.classList.remove("copied");
		}, 1500);
	}
}

/**
 * Render the copy-link button HTML for a message.
 */
function renderCopyLinkButton(entryId) {
	return `<button class="copy-link-btn" data-entry-id="${escapeHtml(entryId)}" title="Copy link to this message">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>`;
}

function renderEntry(entry) {
	const ts = formatTimestamp(entry.timestamp);
	const tsHtml = ts ? `<div class="message-timestamp">${ts}</div>` : "";
	const entryDomId = `entry-${escapeHtml(entry.id)}`;
	const copyBtnHtml = renderCopyLinkButton(entry.id);

	if (entry.type === "message") {
		const msg = entry.message;

		if (msg.role === "user") {
			const content = msg.content;
			const text =
				typeof content === "string"
					? content
					: content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n");
			const skillBlock = parseSkillBlock(text);

			if (skillBlock) {
				// Collect images from content array
				const images = Array.isArray(content) ? content.filter((c) => c.type === "image") : [];
				const hasUserContent = skillBlock.userMessage || images.length > 0;
				let html = `<div class="skill-user-entry" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

				// Skill invocation (collapsed by default, click to expand)
				html += `<div class="skill-invocation" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                <div class="skill-invocation-label">[skill] ${escapeHtml(skillBlock.name)}</div>
                <div class="skill-invocation-collapsed">${escapeHtml(skillBlock.name)} (click to expand)</div>
                <div class="skill-invocation-content markdown-content">${safeMarkedParse(skillBlock.content)}</div>
              </div>`;

				// User message (separate block if present)
				if (hasUserContent) {
					html += '<div class="user-message">';
					if (images.length > 0) {
						html += '<div class="message-images">';
						for (const img of images) {
							html += `<img src="data:${escapeHtml(img.mimeType || "image/png")};base64,${escapeHtml(img.data || "")}" class="message-image" />`;
						}
						html += "</div>";
					}
					if (skillBlock.userMessage) {
						html += `<div class="markdown-content">${safeMarkedParse(skillBlock.userMessage)}</div>`;
					}
					html += "</div>";
				}

				html += "</div>";
				return html;
			}

			// No skill block - normal user message
			let html = `<div class="user-message" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

			if (Array.isArray(content)) {
				const images = content.filter((c) => c.type === "image");
				if (images.length > 0) {
					html += '<div class="message-images">';
					for (const img of images) {
						html += `<img src="data:${escapeHtml(img.mimeType || "image/png")};base64,${escapeHtml(img.data || "")}" class="message-image" />`;
					}
					html += "</div>";
				}
			}

			if (text.trim()) {
				html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
			}
			html += "</div>";
			return html;
		}

		if (msg.role === "assistant") {
			let html = `<div class="assistant-message" id="${entryDomId}">${copyBtnHtml}${tsHtml}`;

			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					html += `<div class="assistant-text markdown-content">${safeMarkedParse(block.text)}</div>`;
				} else if (block.type === "thinking" && block.thinking.trim()) {
					html += `<div class="thinking-block">
                  <div class="thinking-text">${escapeHtml(block.thinking)}</div>
                  <div class="thinking-collapsed">Thinking ...</div>
                </div>`;
				}
			}

			for (const block of msg.content) {
				if (block.type === "toolCall") {
					html += renderToolCall(block);
				}
			}

			if (msg.stopReason === "aborted") {
				html += '<div class="error-text">Aborted</div>';
			} else if (msg.stopReason === "error") {
				html += `<div class="error-text">Error: ${escapeHtml(msg.errorMessage || "Unknown error")}</div>`;
			}

			html += "</div>";
			return html;
		}

		if (msg.role === "bashExecution") {
			const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
			let html = `<div class="tool-execution ${isError ? "error" : "success"}" id="${entryDomId}">${tsHtml}`;
			html += `<div class="tool-command">$ ${escapeHtml(msg.command)}</div>`;
			if (msg.output) html += formatExpandableOutput(msg.output, 10);
			if (msg.cancelled) {
				html += '<div style="color: var(--warning)">(cancelled)</div>';
			} else if (msg.exitCode !== 0 && msg.exitCode !== null) {
				html += `<div style="color: var(--error)">(exit ${msg.exitCode})</div>`;
			}
			html += "</div>";
			return html;
		}

		if (msg.role === "toolResult") return "";
	}

	if (entry.type === "model_change") {
		return `<div class="model-change" id="${entryDomId}">${tsHtml}Switched to model: <span class="model-name">${escapeHtml(entry.provider)}/${escapeHtml(entry.modelId)}</span></div>`;
	}

	if (entry.type === "compaction") {
		return `<div class="compaction" id="${entryDomId}" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
            <div class="compaction-label">[compaction]</div>
            <div class="compaction-collapsed">Compacted from ${entry.tokensBefore.toLocaleString()} tokens</div>
            <div class="compaction-content markdown-content">${safeMarkedParse(entry.summaryDisplay ?? entry.summary)}</div>
          </div>`;
	}

	if (entry.type === "branch_summary") {
		return `<div class="branch-summary" id="${entryDomId}">${tsHtml}
            <div class="branch-summary-header">Branch Summary</div>
            <div class="markdown-content">${safeMarkedParse(entry.summary)}</div>
          </div>`;
	}

	if (entry.type === "custom_message") {
		const hidden = entry.display === false;
		return `<div class="hook-message${hidden ? " hook-message-hidden" : ""}" id="${entryDomId}">${tsHtml}
            <div class="hook-type">[${escapeHtml(entry.customType)}]${hidden ? " · Hidden in terminal" : ""}</div>
            <div class="markdown-content">${safeMarkedParse(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content))}</div>
          </div>`;
	}

	return "";
}
