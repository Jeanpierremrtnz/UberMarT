-- Zonas de geocerca iniciales para Manta.
-- IMPORTANTE: son polígonos APROXIMADOS (rectángulos) para arrancar. Ajusta los
-- límites reales desde el panel (PUT /api/admin/zones/:id con GeoJSON); puedes
-- dibujarlos en https://geojson.io y pegar el polígono.

INSERT INTO zones (slug, name, area, max_multiplier) VALUES
  ('barbasquillo', 'Barbasquillo / Murciélago / Umiña',
   ST_GeomFromText('POLYGON((-80.775 -0.930, -80.738 -0.930, -80.738 -0.975, -80.775 -0.975, -80.775 -0.930))', 4326), 1.50),
  ('centro', 'Centro / Malecón / Av. Flavio Reyes',
   ST_GeomFromText('POLYGON((-80.738 -0.930, -80.718 -0.930, -80.718 -0.975, -80.738 -0.975, -80.738 -0.930))', 4326), 1.50),
  ('tarqui', 'Tarqui',
   ST_GeomFromText('POLYGON((-80.718 -0.935, -80.695 -0.935, -80.695 -0.975, -80.718 -0.975, -80.718 -0.935))', 4326), 1.50),
  ('este', 'Los Esteros / Aeropuerto / Este',
   ST_GeomFromText('POLYGON((-80.695 -0.935, -80.655 -0.935, -80.655 -0.975, -80.695 -0.975, -80.695 -0.935))', 4326), 1.50),
  ('sur', 'Sur (Santa Martha / Altagracia / Circunvalación)',
   ST_GeomFromText('POLYGON((-80.775 -0.975, -80.655 -0.975, -80.655 -1.025, -80.775 -1.025, -80.775 -0.975))', 4326), 1.50),
  ('san-mateo', 'Vía San Mateo / San Mateo / Santa Marianita',
   ST_GeomFromText('POLYGON((-80.840 -0.930, -80.775 -0.930, -80.775 -1.010, -80.840 -1.010, -80.840 -0.930))', 4326), 1.50);

-- Regla horaria: lunes a viernes 07:15-08:15 (entrada a trabajos y colegios) 1.2x.
INSERT INTO pricing_time_rules (name, iso_days, start_local, end_local, multiplier) VALUES
  ('Entrada a trabajos y colegios', ARRAY[1,2,3,4,5]::smallint[], '07:15', '08:15', 1.20);
