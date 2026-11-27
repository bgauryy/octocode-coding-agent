import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export { setVertexNodeModule } from "./ai-sdk/vertex-node.lazy.ts";

export const googleVertexApi = (): ProviderStreams => lazyApi(() => import("./google-vertex.ts"));
