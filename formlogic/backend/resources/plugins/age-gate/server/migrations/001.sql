-- A face check this plugin started and has not decided yet: the turns it asked for, which picture
-- is its control and the digit on it. Deleted the moment it is decided; nothing else is kept.
CREATE TABLE checks(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  min_value INTEGER NOT NULL,
  turns TEXT NOT NULL,
  control INTEGER NOT NULL,
  control_at INTEGER NOT NULL
);
