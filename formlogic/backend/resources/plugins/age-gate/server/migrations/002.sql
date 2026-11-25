-- Track check creation time so abandoned/expired face checks are pruned automatically.
ALTER TABLE checks ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
