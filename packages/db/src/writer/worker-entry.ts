/** The writer's worker file, from source; the Node bundle ships it built as `db-writer-worker.js` (`client.ts`). */
import { runDbWriterWorker } from "./worker.ts";

runDbWriterWorker();
