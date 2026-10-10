-- UberMarT - esquema inicial
-- Dinero siempre en centavos (enteros). Coordenadas en geography(Point, 4326).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;

-- Bloquea UPDATE/DELETE/TRUNCATE en tablas de solo-anexar (libro contable y auditoría).
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es de solo-anexar', TG_TABLE_NAME USING ERRCODE = '42501';
END;
$$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- =====================================================================
-- Administradores del panel
-- =====================================================================
CREATE TABLE admins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  full_name        text NOT NULL CHECK (char_length(full_name) BETWEEN 3 AND 120),
  password_hash    text NOT NULL,
  totp_secret_enc  bytea NOT NULL,
  totp_last_step   bigint NOT NULL DEFAULT 0,
  role             text NOT NULL CHECK (role IN ('owner', 'finance', 'operations')),
  is_active        boolean NOT NULL DEFAULT true,
  failed_logins    integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  csrf_token    text NOT NULL,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

-- =====================================================================
-- Usuarios de las apps (pasajeros y conductores comparten identidad)
-- =====================================================================
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone          text NOT NULL UNIQUE CHECK (phone ~ '^\+5939[0-9]{8}$'),
  full_name      text CHECK (char_length(full_name) BETWEEN 3 AND 120),
  email          citext CHECK (email IS NULL OR char_length(email) <= 254),
  cedula_enc     bytea,
  cedula_bidx    text UNIQUE,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
  status_reason  text,
  rating_sum     integer NOT NULL DEFAULT 0,
  rating_count   integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((cedula_enc IS NULL) = (cedula_bidx IS NULL))
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  code_hash    text NOT NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  ip           inet,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_challenges_phone_idx ON otp_challenges (phone, created_at DESC);

-- Tokens de refresco opacos (solo se guarda su hash), con rotación y
-- detección de reutilización por familia.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  device_id   text NOT NULL CHECK (char_length(device_id) BETWEEN 8 AND 128),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE emergency_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  phone       text NOT NULL CHECK (phone ~ '^\+593[0-9]{8,9}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);

-- =====================================================================
-- Conductores (KYC)
-- =====================================================================
CREATE TABLE drivers (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  kyc_status          text NOT NULL DEFAULT 'draft'
                        CHECK (kyc_status IN ('draft', 'submitted', 'approved', 'rejected', 'suspended')),
  kyc_note            text,
  license_number_enc  bytea,
  license_expires_on  date,
  plate               text UNIQUE CHECK (plate ~ '^[A-Z]{2,3}[0-9]{3,4}[A-Z]?$'),
  moto_brand          text CHECK (char_length(moto_brand) <= 40),
  moto_model          text CHECK (char_length(moto_model) <= 40),
  moto_year           smallint CHECK (moto_year BETWEEN 1990 AND 2100),
  moto_color          text CHECK (char_length(moto_color) <= 30),
  submitted_at        timestamptz,
  reviewed_by         uuid REFERENCES admins(id),
  reviewed_at         timestamptz,
  is_online           boolean NOT NULL DEFAULT false,
  location            geography(Point, 4326),
  location_at         timestamptz,
  heading             smallint CHECK (heading BETWEEN 0 AND 359),
  gps_anomalies       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX drivers_online_location_gix ON drivers USING gist (location) WHERE is_online;
CREATE INDEX drivers_kyc_status_idx ON drivers (kyc_status, submitted_at);
CREATE TRIGGER drivers_touch BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE driver_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id      uuid NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'cedula_front', 'cedula_back', 'license_front', 'license_back',
                   'vehicle_registration', 'criminal_record', 'selfie', 'moto_photo')),
  storage_key    text NOT NULL,
  source_sha256  text NOT NULL,
  bytes          integer NOT NULL,
  width          integer NOT NULL,
  height         integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, kind)
);
-- La misma foto de un documento no puede usarse en dos cuentas distintas.
CREATE UNIQUE INDEX driver_documents_source_uq ON driver_documents (source_sha256);

-- =====================================================================
-- Configuración editable desde el panel
-- =====================================================================
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES admins(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name            text NOT NULL,
  area            geometry(Polygon, 4326) NOT NULL CHECK (ST_IsValid(area)),
  surge_enabled   boolean NOT NULL DEFAULT true,
  max_multiplier  numeric(3, 2) NOT NULL DEFAULT 1.50 CHECK (max_multiplier BETWEEN 1 AND 3),
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zones_area_gix ON zones USING gist (area);

CREATE TABLE pricing_time_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  iso_days     smallint[] NOT NULL CHECK (iso_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[] AND cardinality(iso_days) > 0),
  start_local  time NOT NULL,
  end_local    time NOT NULL CHECK (end_local > start_local),
  multiplier   numeric(3, 2) NOT NULL CHECK (multiplier BETWEEN 1 AND 3),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Billetera virtual del conductor (comisiones prepagadas)
-- =====================================================================
CREATE TABLE wallets (
  driver_id      uuid PRIMARY KEY REFERENCES drivers(user_id),
  balance_cents  bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= -100000),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Libro contable: cada movimiento queda registrado para siempre. La
-- restricción UNIQUE hace imposible acreditar dos veces la misma recarga o
-- cobrar dos veces la comisión del mismo viaje.
CREATE TABLE wallet_entries (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  driver_id            uuid NOT NULL REFERENCES wallets(driver_id),
  amount_cents         bigint NOT NULL CHECK (amount_cents <> 0),
  balance_after_cents  bigint NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('topup', 'commission', 'adjustment', 'refund')),
  ref_type             text NOT NULL,
  ref_id               uuid NOT NULL,
  note                 text,
  admin_id             uuid REFERENCES admins(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_type, ref_id)
);
CREATE INDEX wallet_entries_driver_idx ON wallet_entries (driver_id, id DESC);
CREATE TRIGGER wallet_entries_append_only BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER wallet_entries_no_truncate BEFORE TRUNCATE ON wallet_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- =====================================================================
-- Recargas (comprobantes de transferencia y pasarela de pago)
-- =====================================================================
CREATE TABLE topups (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id             uuid NOT NULL REFERENCES drivers(user_id),
  channel               text NOT NULL CHECK (channel IN ('transfer', 'payphone')),
  bank                  text CHECK (bank IN ('pichincha', 'deuna', 'guayaquil', 'pacifico', 'produbanco',
                                             'bolivariano', 'internacional', 'jep', 'otro')),
  reference             text CHECK (char_length(reference) <= 60),
  reference_norm        text CHECK (reference_norm ~ '^[A-Z0-9]{4,40}$'),
  amount_cents          integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 50000),
  receipt_key           text,
  receipt_sha256        text,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  reject_reason         text CHECK (reject_reason IN ('duplicado', 'ilegible', 'monto_incorrecto',
                                                      'referencia_incorrecta', 'no_acreditado', 'fraude')),
  reject_note           text CHECK (char_length(reject_note) <= 300),
  resubmissions         smallint NOT NULL DEFAULT 0,
  bank_confirmed_at     timestamptz,
  gateway_tx_id         text UNIQUE,
  gateway_payload       jsonb,
  reviewed_by           uuid REFERENCES admins(id),
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (channel <> 'transfer' OR (bank IS NOT NULL AND reference_norm IS NOT NULL
                                   AND receipt_key IS NOT NULL AND receipt_sha256 IS NOT NULL)),
  CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE TRIGGER topups_touch BEFORE UPDATE ON topups FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE INDEX topups_queue_idx ON topups (created_at) WHERE status = 'pending' AND channel = 'transfer';
CREATE INDEX topups_driver_idx ON topups (driver_id, created_at DESC);

-- FILTRO ANTIDUPLICADOS: una referencia bancaria y una misma imagen de
-- comprobante solo pueden registrarse una vez en todo el sistema (sin importar
-- el banco ni el conductor). Solo se liberan si el panel rechazó la recarga
-- porque el conductor digitó mal la referencia.
CREATE UNIQUE INDEX topups_reference_uq ON topups (reference_norm)
  WHERE channel = 'transfer' AND NOT (status = 'rejected' AND reject_reason = 'referencia_incorrecta');
CREATE UNIQUE INDEX topups_receipt_uq ON topups (receipt_sha256)
  WHERE channel = 'transfer' AND NOT (status = 'rejected' AND reject_reason = 'referencia_incorrecta');

-- Conciliación: líneas importadas del estado de cuenta bancario.
CREATE TABLE bank_statement_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference_norm  text NOT NULL,
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  posted_on       date,
  description     text,
  imported_by     uuid NOT NULL REFERENCES admins(id),
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_norm, amount_cents)
);

CREATE TABLE gateway_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      text NOT NULL,
  event_key     text NOT NULL,
  payload       jsonb NOT NULL,
  result        text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);

-- =====================================================================
-- Viajes
-- =====================================================================
CREATE TABLE fare_quotes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id       uuid NOT NULL REFERENCES users(id),
  origin             geography(Point, 4326) NOT NULL,
  destination        geography(Point, 4326) NOT NULL,
  origin_label       text CHECK (char_length(origin_label) <= 160),
  destination_label  text CHECK (char_length(destination_label) <= 160),
  zone_id            uuid REFERENCES zones(id),
  distance_m         integer NOT NULL CHECK (distance_m > 0),
  duration_s         integer NOT NULL CHECK (duration_s > 0),
  breakdown          jsonb NOT NULL,
  total_cents        integer NOT NULL CHECK (total_cents > 0),
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fare_quotes_zone_recent_idx ON fare_quotes (zone_id, created_at DESC);

CREATE TABLE trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id           uuid NOT NULL UNIQUE REFERENCES fare_quotes(id),
  passenger_id       uuid NOT NULL REFERENCES users(id),
  driver_id          uuid REFERENCES drivers(user_id),
  status             text NOT NULL DEFAULT 'searching'
                       CHECK (status IN ('searching', 'accepted', 'arrived', 'in_progress',
                                         'completed', 'cancelled', 'expired')),
  origin             geography(Point, 4326) NOT NULL,
  destination        geography(Point, 4326) NOT NULL,
  origin_label       text,
  destination_label  text,
  zone_id            uuid REFERENCES zones(id),
  distance_m         integer NOT NULL,
  duration_s         integer NOT NULL,
  fare_cents         integer NOT NULL CHECK (fare_cents > 0),
  commission_cents   integer CHECK (commission_cents >= 0),
  payment_method     text NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash')),
  pin                text NOT NULL CHECK (pin ~ '^[0-9]{4}$'),
  pin_attempts       smallint NOT NULL DEFAULT 0,
  share_token_hash   text UNIQUE,
  dispatch_round     smallint NOT NULL DEFAULT 0,
  last_dispatch_at   timestamptz,
  cancelled_by       text CHECK (cancelled_by IN ('passenger', 'driver', 'system', 'admin')),
  cancel_reason      text CHECK (char_length(cancel_reason) <= 200),
  rating_by_passenger smallint CHECK (rating_by_passenger BETWEEN 1 AND 5),
  rating_by_driver   smallint CHECK (rating_by_driver BETWEEN 1 AND 5),
  requested_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  arrived_at         timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz
);
-- Un conductor y un pasajero solo pueden tener un viaje activo a la vez.
CREATE UNIQUE INDEX trips_active_driver_uq ON trips (driver_id)
  WHERE status IN ('accepted', 'arrived', 'in_progress');
CREATE UNIQUE INDEX trips_active_passenger_uq ON trips (passenger_id)
  WHERE status IN ('searching', 'accepted', 'arrived', 'in_progress');
CREATE INDEX trips_searching_idx ON trips (last_dispatch_at) WHERE status = 'searching';
CREATE INDEX trips_zone_searching_idx ON trips (zone_id) WHERE status = 'searching';
CREATE INDEX trips_passenger_idx ON trips (passenger_id, requested_at DESC);
CREATE INDEX trips_driver_idx ON trips (driver_id, requested_at DESC);

CREATE TABLE trip_offers (
  trip_id       uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id     uuid NOT NULL REFERENCES drivers(user_id),
  round         smallint NOT NULL,
  distance_m    integer NOT NULL,
  offered_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  response      text CHECK (response IN ('accepted', 'declined', 'expired')),
  PRIMARY KEY (trip_id, driver_id)
);

-- Recorrido real del viaje (para investigar incidentes de seguridad).
CREATE TABLE trip_points (
  trip_id   uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  point     geography(Point, 4326) NOT NULL,
  speed_kmh smallint
);
CREATE INDEX trip_points_trip_idx ON trip_points (trip_id, at);

-- =====================================================================
-- Seguridad: botón de pánico y reportes
-- =====================================================================
CREATE TABLE safety_incidents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        uuid REFERENCES trips(id),
  reporter_id    uuid NOT NULL REFERENCES users(id),
  reporter_role  text NOT NULL CHECK (reporter_role IN ('passenger', 'driver')),
  kind           text NOT NULL CHECK (kind IN ('sos', 'report')),
  location       geography(Point, 4326),
  message        text CHECK (char_length(message) <= 500),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  handled_by     uuid REFERENCES admins(id),
  handled_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_incidents_open_idx ON safety_incidents (created_at DESC) WHERE status <> 'resolved';

-- =====================================================================
-- Auditoría (solo-anexar)
-- =====================================================================
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type   text NOT NULL CHECK (actor_type IN ('admin', 'user', 'system', 'gateway')),
  actor_id     uuid,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  ip           inet,
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
