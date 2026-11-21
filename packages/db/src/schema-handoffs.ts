/**
 * `item_handoffs`: the backlog items a coordinator handed to a running child after its start (`queries/item-handoffs.ts`),
 * one row per child and item, so the child's own process may update them besides the item it was started for. Rows end
 * with the child's run. Created with IF NOT EXISTS: an
 * existing file of this version gains it when it is opened (`COORDINATION_FILE.ensure`).
 */
export const ITEM_HANDOFFS_SCHEMA = `
CREATE TABLE IF NOT EXISTS item_handoffs (
  agent TEXT NOT NULL, item_id INTEGER NOT NULL, by_agent TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (agent, item_id));
CREATE INDEX IF NOT EXISTS item_handoffs_by ON item_handoffs(by_agent);
`;
