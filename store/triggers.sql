-- external-content FTS5 tables need triggers to stay in sync with their base table.
-- Without these the index is silently empty and retrieval looks like a bad retriever.

DROP TRIGGER IF EXISTS product_ai;
DROP TRIGGER IF EXISTS product_ad;
DROP TRIGGER IF EXISTS product_au;

CREATE TRIGGER product_ai AFTER INSERT ON product BEGIN
  INSERT INTO product_fts(rowid, title, description, tags_json)
  VALUES (new.rowid, new.title, new.description, new.tags_json);
END;

CREATE TRIGGER product_ad AFTER DELETE ON product BEGIN
  INSERT INTO product_fts(product_fts, rowid, title, description, tags_json)
  VALUES ('delete', old.rowid, old.title, old.description, old.tags_json);
END;

CREATE TRIGGER product_au AFTER UPDATE ON product BEGIN
  INSERT INTO product_fts(product_fts, rowid, title, description, tags_json)
  VALUES ('delete', old.rowid, old.title, old.description, old.tags_json);
  INSERT INTO product_fts(rowid, title, description, tags_json)
  VALUES (new.rowid, new.title, new.description, new.tags_json);
END;

DROP TRIGGER IF EXISTS policy_ai;
DROP TRIGGER IF EXISTS policy_ad;
DROP TRIGGER IF EXISTS policy_au;

CREATE TRIGGER policy_ai AFTER INSERT ON policy_chunk BEGIN
  INSERT INTO policy_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER policy_ad AFTER DELETE ON policy_chunk BEGIN
  INSERT INTO policy_fts(policy_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER policy_au AFTER UPDATE ON policy_chunk BEGIN
  INSERT INTO policy_fts(policy_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO policy_fts(rowid, text) VALUES (new.rowid, new.text);
END;
