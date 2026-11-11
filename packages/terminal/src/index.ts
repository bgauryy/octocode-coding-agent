export { ShellCompletionService, type ShellCompletionServiceOptions, toCompletions } from "./service.ts";
export { parseShellLine, quoteForShell, type ShellLine } from "./line.ts";
export { type HistoryEntry, rankHistory, replyCommands, suggestCommand } from "./suggest.ts";
export { type AskModel, commandFromReply, type NextCommandRequest, NextCommandSuggester } from "./next-command.ts";
export { resolveShell } from "./shells/index.ts";
export type { ShellCompletion, ShellCompletions, ShellName, ShellSetting, ShellCompletionOptions } from "./types.ts";
