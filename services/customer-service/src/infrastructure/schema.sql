CREATE TABLE IF NOT EXISTS memberships (
  mid INTEGER PRIMARY KEY,
  mname VARCHAR(50) NOT NULL UNIQUE,
  score INTEGER NOT NULL CHECK (score >= 0)
);

-- DEMO fixtures: supplied documents do not define these names or scores.
-- ON CONFLICT DO NOTHING preserves changes made after initial setup.
INSERT INTO memberships(mid,mname,score) VALUES
  (1, 'Basic', 0), (2, 'Silver', 100), (3, 'Gold', 500)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS customers (
  uid INTEGER PRIMARY KEY,
  fullname VARCHAR(100) NOT NULL,
  mid INTEGER NOT NULL DEFAULT 1 REFERENCES memberships(mid)
);
