// NAVIGATION
// ============================================================

// Cache for rendered entry DOM nodes
const entryCache = new Map();

function getScrollTargetElementId(entryId) {
	const entry = byId.get(entryId);
	if (entry?.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId) {
		// getElementById() matches the parsed DOM id attribute, whose HTML entities
		// were already resolved from the escaped id rendered by renderToolCall().
		return `tool-call-${entry.message.toolCallId}`;
	}
	return `entry-${entryId}`;
}

function renderEntryToNode(entry) {
	// Check cache first
	if (entryCache.has(entry.id)) {
		return entryCache.get(entry.id).cloneNode(true);
	}

	// Render to HTML string, then parse to node
	const html = renderEntry(entry);
	if (!html) return null;

	const template = document.createElement("template");
	template.innerHTML = html;
	const node = template.content.firstElementChild;

	// Cache the node
	if (node) {
		entryCache.set(entry.id, node.cloneNode(true));
	}
	return node;
}

function navigateTo(targetId, scrollMode = "target", scrollToEntryId = null) {
	currentLeafId = targetId;
	currentTargetId = scrollToEntryId ?? targetId;
	const targetEntry = byId.get(currentTargetId);
	if (scrollMode === "target" && targetEntry?.type === "custom_message" && targetEntry.display === false) {
		setHiddenMessagesVisible(true);
	}
	const path = getPath(targetId);

	renderTree();

	document.getElementById("header-container").innerHTML = renderHeader();
	attachHeaderHandlers();

	// Build messages using cached DOM nodes
	const messagesEl = document.getElementById("messages");
	const fragment = document.createDocumentFragment();

	for (const entry of path) {
		const node = renderEntryToNode(entry);
		if (node) {
			fragment.appendChild(node);
		}
	}

	messagesEl.innerHTML = "";
	messagesEl.appendChild(fragment);

	// Cached nodes contain their initial presentation; reapply the viewer's toggle states.
	setThinkingExpanded(thinkingExpanded);
	setToolOutputsExpanded(toolOutputsExpanded);

	// Attach click handlers for copy-link buttons
	messagesEl.querySelectorAll(".copy-link-btn").forEach((btn) => {
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const entryId = btn.dataset.entryId;
			const shareUrl = buildShareUrl(entryId);
			void copyToClipboard(shareUrl, btn);
		});
	});

	// Use setTimeout(0) to ensure DOM is fully laid out before scrolling
	setTimeout(() => {
		const content = document.getElementById("content");
		if (scrollMode === "bottom") {
			content.scrollTop = content.scrollHeight;
		} else if (scrollMode === "target") {
			// If scrollToEntryId is provided, scroll to that specific entry.
			// Tool result entries are rendered inside their assistant tool-call block,
			// so route them to the visible tool-call element instead.
			const scrollTargetId = scrollToEntryId ?? targetId;
			const targetEl =
				document.getElementById(getScrollTargetElementId(scrollTargetId)) ??
				document.getElementById(`entry-${scrollTargetId}`);
			if (targetEl) {
				targetEl.scrollIntoView({ block: "center" });
				// Briefly highlight the target message
				if (scrollToEntryId) {
					targetEl.classList.add("highlight");
					setTimeout(() => targetEl.classList.remove("highlight"), 2000);
				}
			}
		}
	}, 0);
}
