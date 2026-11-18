/** The resource kinds a package or settings entry can name, and the file names each kind uses. A leaf: discovery reads it without the package manager. */
export type ResourceType = "skills" | "prompts" | "themes";

export const RESOURCE_TYPES: ResourceType[] = ["skills", "prompts", "themes"];

export const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};
