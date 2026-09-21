-- Solo Tinta Ink — D1 schema v1
-- Sin promociones. Sin seña. Sin catálogo de precios públicos.
-- Duraciones: minutos enteros. El frontend puede mostrarlas como H:MM.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  studio_name TEXT NOT NULL DEFAULT 'Solo Tinta Ink',
  artist_name TEXT NOT NULL DEFAULT 'Felipe Herrera',
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  maps_url TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '@solo.tinta.ink',
  safety_info TEXT NOT NULL DEFAULT '',
  contact_info TEXT NOT NULL DEFAULT '',
  schedule_json TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  whatsapp TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  description TEXT NOT NULL,
  body_area TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',
  reference_key TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending_quote','awaiting_confirmation','scheduled','discarded','cancelled')
  ),
  price INTEGER,
  duration_minutes INTEGER,
  quoted_at TEXT,
  discarded_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  quote_id TEXT REFERENCES quotes(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  price INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('scheduled','completed','cancelled','another_session')
  ) DEFAULT 'scheduled',
  payment_method TEXT CHECK (payment_method IN ('cash','transfer') OR payment_method IS NULL),
  another_session_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS day_blocks (
  date TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'unidad',
  minimum_quantity REAL NOT NULL DEFAULT 0,
  last_restocked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  stock_item_id TEXT NOT NULL REFERENCES stock_items(id),
  appointment_id TEXT REFERENCES appointments(id),
  type TEXT NOT NULL CHECK (type IN ('restock','usage','adjustment')),
  quantity REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_id TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  subscription_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Serialización corta por día para impedir dobles reservas concurrentes.
CREATE TABLE IF NOT EXISTS schedule_locks (
  date TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Historial explícito de reprogramaciones, cancelaciones, finalizaciones,
-- seguimientos y otros eventos relevantes del contacto.
CREATE TABLE IF NOT EXISTS history_events (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  appointment_id TEXT REFERENCES appointments(id),
  quote_id TEXT REFERENCES quotes(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_quotes_status_created
  ON quotes(status, created_at);

CREATE INDEX IF NOT EXISTS idx_quotes_client
  ON quotes(client_id, created_at);

CREATE INDEX IF NOT EXISTS idx_appointments_date_time
  ON appointments(date, start_time);

CREATE INDEX IF NOT EXISTS idx_appointments_client
  ON appointments(client_id, date);

CREATE INDEX IF NOT EXISTS idx_followups_client
  ON followups(client_id, created_at);

CREATE INDEX IF NOT EXISTS idx_stock_movements_item
  ON stock_movements(stock_item_id, created_at);

CREATE INDEX IF NOT EXISTS idx_notifications_seen_created
  ON notifications(seen, created_at);

CREATE INDEX IF NOT EXISTS idx_history_client_created
  ON history_events(client_id, created_at);

CREATE INDEX IF NOT EXISTS idx_history_appointment
  ON history_events(appointment_id, created_at);

CREATE INDEX IF NOT EXISTS idx_history_quote
  ON history_events(quote_id, created_at);

CREATE INDEX IF NOT EXISTS idx_schedule_locks_created
  ON schedule_locks(created_at);

-- Valores iniciales.
-- Los textos de abajo (descripción, dirección, seguridad, contacto) son de
-- ejemplo — Feli los puede editar en cualquier momento desde
-- Gestión > Ajustes > "Editar datos del estudio".
INSERT OR IGNORE INTO settings
(id, studio_name, artist_name, description, address, maps_url, instagram, safety_info, contact_info, schedule_json, pin_hash)
VALUES
(
  1,
  'Solo Tinta Ink',
  'Felipe Herrera',
  'Estudio de tatuajes especializado en fine line, black & grey y realismo. Feli atiende con cita previa, un cliente a la vez, para dar tranquilidad y atención personalizada en cada sesión.',
  'Av. Colón 1140, Pergamino, Buenos Aires',
  'https://maps.google.com/?q=Av.+Colón+1140,+Pergamino,+Buenos+Aires',
  '@solo.tinta.ink',
  'Todo el material de un solo uso (agujas, guantes, campos, vaselina) se abre nuevo delante del cliente y se descarta después de cada sesión. El instrumental reutilizable se esteriliza en autoclave certificado, y se trabaja con tintas homologadas para uso dérmico. Feli mantiene actualizado su curso de bioseguridad para tatuadores.',
  'WhatsApp del estudio: +54 9 2477 40-1234 · También por Instagram (@solo.tinta.ink)',
  '{"0":[],"1":[["09:30","21:30"]],"2":[["09:30","21:30"]],"3":[["09:30","21:30"]],"4":[["09:30","21:30"]],"5":[["09:30","21:30"]],"6":[["09:30","21:30"]]}',
  'a20c25627ed7bbb6d2b999c589b698e6ecd84384e2e0e510d8869d79a5ad244c'
);


-- Insumos iniciales sugeridos. Se pueden editar desde Gestión.
INSERT OR IGNORE INTO stock_items(id,name,quantity,unit,minimum_quantity)
VALUES
('stock_black_ink','Tinta negra',0,'ml',30),
('stock_color_ink','Tinta de color',0,'ml',30),
('stock_caps','Caps',0,'unidad',20),
('stock_vaseline','Vaselina',0,'g',50),
('stock_fields','Campos',0,'unidad',10),
('stock_gloves','Guantes',0,'unidad',20),
('stock_needles','Agujas',0,'unidad',10);
