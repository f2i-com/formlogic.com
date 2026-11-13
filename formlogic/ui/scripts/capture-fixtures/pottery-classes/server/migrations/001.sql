CREATE TABLE classes(id INTEGER PRIMARY KEY, title TEXT NOT NULL, starts TEXT NOT NULL, note TEXT NOT NULL, price TEXT NOT NULL, places INTEGER NOT NULL);
CREATE TABLE bookings(id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id), name TEXT NOT NULL, places INTEGER NOT NULL DEFAULT 1);
INSERT INTO classes(id, title, starts, note, price, places) VALUES
  (1, 'Wheel throwing for beginners', 'Saturday, 10:00 to 12:30', 'Centre the clay and throw your first two bowls.', '$48', 8),
  (2, 'Hand-built mugs', 'Sunday, 14:00 to 16:00', 'Slab and coil techniques. Take home two mugs.', '$36', 10),
  (3, 'Glazing workshop', 'Wednesday, 18:30 to 20:00', 'Dip, pour and brush glazes on your fired pieces.', '$30', 6),
  (4, 'Family clay morning', 'Next Saturday, 9:30 to 11:00', 'For one adult and one child, ages 6 and up.', '$40', 6);
INSERT INTO bookings(class_id, name, places) VALUES
  (1, 'Jordan Wells', 2),
  (1, 'Priya Nair', 1),
  (1, 'Casey Lee', 2),
  (2, 'Mia Donovan', 1),
  (2, 'Ethan Marsh', 2),
  (3, 'Harper Quinn', 2),
  (3, 'Amelia Frost', 2),
  (3, 'Mason Reed', 2),
  (4, 'Isabella Cross', 2);
