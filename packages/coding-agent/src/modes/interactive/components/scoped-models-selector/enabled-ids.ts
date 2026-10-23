// EnabledIds: null = all enabled (no filter), string[] = explicit ordered list
export type EnabledIds = string[] | null;

export function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

/** Collapse an explicit list back to null (= all enabled) when it covers every available model. */
function normalizeEnabled(result: string[], allIds: string[]): EnabledIds {
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

export function toggle(enabledIds: EnabledIds, allIds: string[], id: string): EnabledIds {
	if (enabledIds === null) return allIds.filter((modelId) => modelId !== id);
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return normalizeEnabled([...enabledIds, id], allIds);
}

export function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // Already all enabled
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return normalizeEnabled(result, allIds);
}

export function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

export function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

export function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}
