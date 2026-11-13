ALTER TABLE items ADD COLUMN done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN created_at INTEGER;
INSERT INTO items(title, done) VALUES
  ('Unload Friday’s bisque firing', 0),
  ('Order four bags of stoneware clay', 0),
  ('Glaze the café’s mug order', 0),
  ('Mix a new batch of celadon glaze', 0),
  ('Photograph new pieces for the shop', 1);
