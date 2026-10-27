CREATE TABLE IF NOT EXISTS order_attempts (
  operation_id UUID PRIMARY KEY,
  uid INTEGER NOT NULL,
  request JSONB NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','COMMITTED','ABORTING','ABORTED')),
  lease_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  oid SERIAL PRIMARY KEY,
  operation_id UUID NOT NULL UNIQUE REFERENCES order_attempts(operation_id),
  uid INTEGER NOT NULL,
  discount NUMERIC(10,2) NOT NULL CHECK (discount >= 0),
  subtotal NUMERIC(10,2) NOT NULL CHECK (subtotal >= 0),
  total_amount NUMERIC(10,2) NOT NULL CHECK (total_amount >= 0),
  score INTEGER NOT NULL,
  discount_rate INTEGER NOT NULL CHECK (discount_rate BETWEEN 0 AND 100),
  event_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_uid_idx ON orders(uid);
CREATE TABLE IF NOT EXISTS order_details (
  oid INTEGER NOT NULL REFERENCES orders(oid),
  pid INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (oid,pid)
);
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id UUID PRIMARY KEY,
  aggregate_id INTEGER NOT NULL REFERENCES orders(oid),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events(created_at) WHERE status='PENDING';
