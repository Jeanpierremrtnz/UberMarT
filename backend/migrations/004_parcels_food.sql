-- Servicios adicionales en moto: mensajería (encomiendas) y delivery de comida.
-- Reutilizan el mismo motor de viajes (cotización, despacho, GPS, PIN, SOS,
-- comisiones); cada viaje indica su tipo de servicio.

-- ---------------------------------------------------------------------
-- Tipo de servicio en cotizaciones y viajes
-- ---------------------------------------------------------------------
ALTER TABLE fare_quotes
  ADD COLUMN service text NOT NULL DEFAULT 'ride' CHECK (service IN ('ride', 'parcel', 'food')),
  -- Datos validados al cotizar (paquete o carrito). El cliente no puede alterarlos después.
  ADD COLUMN payload jsonb;

ALTER TABLE trips
  ADD COLUMN service text NOT NULL DEFAULT 'ride' CHECK (service IN ('ride', 'parcel', 'food')),
  -- PIN que el destinatario/cliente dicta al recibir (mensajería y comida).
  ADD COLUMN delivery_pin text CHECK (delivery_pin ~ '^[0-9]{4}$'),
  ADD COLUMN delivery_pin_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN pickup_photo_key text,
  ADD COLUMN dropoff_photo_key text,
  -- Efectivo que el motorizado cobra y, en comida, lo que paga al local al retirar.
  ADD COLUMN collect_cents integer CHECK (collect_cents >= 0),
  ADD COLUMN collect_at text CHECK (collect_at IN ('pickup', 'dropoff')),
  ADD COLUMN pay_merchant_cents integer CHECK (pay_merchant_cents >= 0),
  ADD CONSTRAINT trips_delivery_pin_required CHECK (service = 'ride' OR delivery_pin IS NOT NULL);

-- Un pasajero solo puede tener un viaje propio activo; envíos y pedidos pueden ser varios.
DROP INDEX trips_active_passenger_uq;
CREATE UNIQUE INDEX trips_active_passenger_uq ON trips (passenger_id)
  WHERE service = 'ride' AND status IN ('searching', 'accepted', 'arrived', 'in_progress');
CREATE INDEX trips_active_customer_idx ON trips (passenger_id, service)
  WHERE status IN ('searching', 'accepted', 'arrived', 'in_progress');

-- ---------------------------------------------------------------------
-- Mensajería
-- ---------------------------------------------------------------------
CREATE TABLE trip_parcels (
  trip_id               uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  recipient_name        text NOT NULL CHECK (char_length(recipient_name) BETWEEN 2 AND 80),
  recipient_phone       text NOT NULL CHECK (recipient_phone ~ '^\+5939[0-9]{8}$'),
  description           text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 200),
  size                  text NOT NULL CHECK (size IN ('sobre', 'pequeno', 'mediano')),
  weight_kg             numeric(4, 1) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 30),
  declared_value_cents  integer NOT NULL DEFAULT 0 CHECK (declared_value_cents >= 0),
  payer                 text NOT NULL CHECK (payer IN ('sender', 'recipient')),
  recipient_notified_at timestamptz
);

-- ---------------------------------------------------------------------
-- Delivery de comida: locales, menú, pedidos y cuenta del local
-- ---------------------------------------------------------------------
CREATE TABLE merchants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  category           text NOT NULL CHECK (category IN ('restaurante', 'cafeteria', 'comida_rapida', 'panaderia', 'farmacia', 'tienda', 'otro')),
  -- Celular del dueño, verificado por SMS durante el registro.
  phone              text NOT NULL CHECK (phone ~ '^\+5939[0-9]{8}$'),
  address_label      text NOT NULL CHECK (char_length(address_label) BETWEEN 5 AND 160),
  location           geography(Point, 4326) NOT NULL,
  ruc                text NOT NULL UNIQUE CHECK (ruc ~ '^[0-9]{13}$'),
  owner_name         text NOT NULL CHECK (char_length(owner_name) BETWEEN 3 AND 120),
  owner_cedula_enc   bytea NOT NULL,
  schedule_text      text CHECK (char_length(schedule_text) <= 120),
  -- Registro autogestionado: draft -> submitted -> approved / rejected; suspended por el panel.
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'suspended')),
  review_note        text CHECK (char_length(review_note) <= 300),
  submitted_at       timestamptz,
  reviewed_by        uuid REFERENCES admins(id),
  reviewed_at        timestamptz,
  commission_bps     integer NOT NULL DEFAULT 1000 CHECK (commission_bps BETWEEN 0 AND 5000),
  prep_minutes       smallint NOT NULL DEFAULT 15 CHECK (prep_minutes BETWEEN 1 AND 120),
  is_open            boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchants_status_idx ON merchants (status, submitted_at);

CREATE TABLE merchant_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('ruc', 'permiso_funcionamiento', 'cedula_owner', 'storefront')),
  storage_key    text NOT NULL,
  source_sha256  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, kind)
);
CREATE UNIQUE INDEX merchant_documents_source_uq ON merchant_documents (source_sha256);

CREATE INDEX merchants_location_gix ON merchants USING gist (location) WHERE status = 'approved';

CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  category      text NOT NULL DEFAULT 'General' CHECK (char_length(category) BETWEEN 1 AND 40),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description   text CHECK (char_length(description) <= 300),
  price_cents   integer NOT NULL CHECK (price_cents BETWEEN 1 AND 100000),
  is_available  boolean NOT NULL DEFAULT true,
  photo_key     text,
  sort_order    smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_merchant_idx ON menu_items (merchant_id, sort_order);
CREATE TRIGGER menu_items_touch BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6}$'),
  merchant_id         uuid NOT NULL REFERENCES merchants(id),
  customer_id         uuid NOT NULL REFERENCES users(id),
  quote_id            uuid NOT NULL UNIQUE REFERENCES fare_quotes(id),
  trip_id             uuid UNIQUE REFERENCES trips(id),
  items               jsonb NOT NULL,
  subtotal_cents      integer NOT NULL CHECK (subtotal_cents > 0),
  delivery_fee_cents  integer NOT NULL CHECK (delivery_fee_cents > 0),
  total_cents         integer NOT NULL CHECK (total_cents = subtotal_cents + delivery_fee_cents),
  commission_cents    integer CHECK (commission_cents >= 0),
  customer_note       text CHECK (char_length(customer_note) <= 300),
  status              text NOT NULL DEFAULT 'placed'
                        CHECK (status IN ('placed', 'accepted', 'ready', 'picked_up', 'delivered', 'rejected', 'cancelled')),
  status_reason       text CHECK (char_length(status_reason) <= 200),
  prep_minutes        smallint CHECK (prep_minutes BETWEEN 1 AND 120),
  dispatch_at         timestamptz,
  placed_at           timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  ready_at            timestamptz,
  picked_up_at        timestamptz,
  delivered_at        timestamptz,
  closed_at           timestamptz
);
CREATE INDEX orders_merchant_idx ON orders (merchant_id, placed_at DESC);
CREATE INDEX orders_customer_idx ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_waiting_merchant_idx ON orders (placed_at) WHERE status = 'placed';
CREATE INDEX orders_pending_dispatch_idx ON orders (dispatch_at) WHERE trip_id IS NULL AND status IN ('accepted', 'ready');

-- Cuenta del local con la plataforma (solo-anexar). Positivo = el local debe a la plataforma.
CREATE TABLE merchant_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id   uuid NOT NULL REFERENCES merchants(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0),
  kind          text NOT NULL CHECK (kind IN ('commission', 'payment', 'adjustment')),
  ref_type      text NOT NULL,
  ref_id        uuid NOT NULL,
  note          text CHECK (char_length(note) <= 300),
  admin_id      uuid REFERENCES admins(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_type, ref_id)
);
CREATE INDEX merchant_ledger_merchant_idx ON merchant_ledger (merchant_id, id DESC);
CREATE TRIGGER merchant_ledger_append_only BEFORE UPDATE OR DELETE ON merchant_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER merchant_ledger_no_truncate BEFORE TRUNCATE ON merchant_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Códigos SMS con propósito: ingreso a la app o verificación del celular de un local.
ALTER TABLE otp_challenges
  ADD COLUMN purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'merchant_signup'));

-- Usuarios de los locales: misma seguridad que el panel (contraseña + TOTP),
-- pero con rol "merchant" limitado a su propio local.
ALTER TABLE admins DROP CONSTRAINT admins_role_check;
ALTER TABLE admins
  ADD CONSTRAINT admins_role_check CHECK (role IN ('owner', 'finance', 'operations', 'merchant')),
  ADD COLUMN merchant_id uuid REFERENCES merchants(id),
  ADD CONSTRAINT admins_merchant_scope CHECK ((role = 'merchant') = (merchant_id IS NOT NULL));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ubermart_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON merchant_ledger FROM ubermart_app;
  END IF;
END
$$;
