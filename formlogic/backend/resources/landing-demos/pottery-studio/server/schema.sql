PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  instructor TEXT NOT NULL,
  schedule TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'All levels',
  price_usd INTEGER NOT NULL DEFAULT 65,
  capacity INTEGER NOT NULL DEFAULT 8,
  spots_booked INTEGER NOT NULL DEFAULT 0,
  clay_type TEXT NOT NULL DEFAULT 'Speckled stoneware',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO classes (id, title, instructor, schedule, level, price_usd, capacity, spots_booked, clay_type) VALUES
  (1, 'Wheel Throwing Intro', 'Maya Chen', 'Sat, 10:00 AM', 'Beginner', 68, 8, 5, 'Buff stoneware'),
  (2, 'Hand-Built Stoneware Mugs', 'Liam Patel', 'Sun, 1:30 PM', 'All levels', 58, 10, 6, 'Speckled buff'),
  (3, 'Glaze & Kiln Chemistry', 'Hannah Sato', 'Wed, 6:00 PM', 'Intermediate', 75, 6, 4, 'Porcelain blend'),
  (4, 'Weekend Bowl & Vase Studio', 'Maya Chen', 'Fri, 5:30 PM', 'All levels', 72, 8, 2, 'Terracotta red');

INSERT OR IGNORE INTO bookings (id, class_id, guest_name, guest_email, seats, note, status) VALUES
  (1, 1, 'Claire Brooks', 'claire@example.com', 2, 'First time on the wheel!', 'confirmed'),
  (2, 2, 'Daniel Ortiz', 'daniel@example.com', 1, 'Matte sage glaze', 'confirmed');
