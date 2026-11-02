/** The resource kinds a package or settings entry can name, and the file names each kind uses. A leaf: discovery reads it without the package manager. */
export type ResourceType = "extensions" | "skills" | "prompts" | "themes";

export const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

export const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};
