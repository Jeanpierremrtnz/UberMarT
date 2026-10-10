import pg from 'pg';

// int8 (bigint) -> Number. Los montos en centavos están muy por debajo de 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export function createDb({ connectionString, max = 10, logger }) {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'ubermart-api',
  });
  pool.on('error', (err) => logger?.error({ err }, 'Error inesperado en el pool de PostgreSQL'));

  return {
    pool,
    query: (text, params) => pool.query(text, params),
    async one(text, params) {
      const { rows } = await pool.query(text, params);
      return rows[0] ?? null;
    },
    /** Ejecuta fn dentro de una transacción; hace ROLLBACK ante cualquier error. */
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
