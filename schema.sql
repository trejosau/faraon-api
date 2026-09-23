-- Esquema PostgreSQL/Supabase. La API aplica esta estructura automáticamente
-- al iniciar usando api/migrations/001_initial.sql.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  stripe_session_id VARCHAR(255) UNIQUE,
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  payment_mode VARCHAR(20) NOT NULL CHECK (payment_mode IN ('cash', 'credit')),
  amount_mxn NUMERIC(12, 2) NOT NULL,
  shipping_amount_mxn NUMERIC(12, 2) NOT NULL DEFAULT 0,
  delivery_method VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (delivery_method IN ('local', 'national')),
  shipping_zone VARCHAR(80) NOT NULL DEFAULT 'Comarca Lagunera',
  recipient_name VARCHAR(120) NOT NULL DEFAULT '',
  recipient_phone VARCHAR(40) NOT NULL DEFAULT '',
  address_line VARCHAR(190) NOT NULL DEFAULT '',
  city VARCHAR(100) NOT NULL DEFAULT '',
  state VARCHAR(100) NOT NULL DEFAULT '',
  postal_code VARCHAR(10) NOT NULL DEFAULT '',
  carrier VARCHAR(100),
  tracking_number VARCHAR(120),
  tracking_url VARCHAR(500),
  shipping_status VARCHAR(40) NOT NULL DEFAULT 'pending',
  status VARCHAR(40) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id VARCHAR(80) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount_mxn NUMERIC(12, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id, id);
