-- Mínimo privilegio para el usuario de la aplicación en producción.
-- La API se conecta como "ubermart_app" (ver infra/db/init). Aunque alguien
-- tomara control de la API, no podría alterar ni borrar el libro contable ni
-- la auditoría: solo puede leerlos y anexar registros nuevos.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ubermart_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON wallet_entries, audit_log, bank_statement_lines, gateway_events FROM ubermart_app;
    REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM ubermart_app;
    REVOKE ALL ON schema_migrations FROM ubermart_app;
  END IF;
END
$$;
