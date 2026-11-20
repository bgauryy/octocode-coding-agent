/**
 * `item_handoffs`: the backlog items a coordinator handed to a running child after its start (`queries/item-handoffs.ts`),
 * one row per child and item, so the child's own process may update them besides the item it was started for. Rows end
 * with the child's run. Written with IF NOT EXISTS so a file created before the table existed gains it at first use
 * (`itemHandoffs.ensure`) without a schema version change, which would set the whole file aside.
 */
export const ITEM_HANDOFFS_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_handoffs (
  agent TEXT NOT NULL, item_id INTEGER NOT NULL, by_agent TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (agent, item_id));
CREATE INDEX IF NOT EXISTS item_handoffs_by ON item_handoffs(by_agent);
`;
