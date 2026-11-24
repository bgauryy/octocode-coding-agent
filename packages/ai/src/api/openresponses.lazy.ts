import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openResponsesApi = (): ProviderStreams => lazyApi(() => import("./openresponses.ts"));
