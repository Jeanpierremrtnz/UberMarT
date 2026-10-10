export function createAuditService({ db, logger }) {
  return {
    /** Registra una acción en la bitácora inmutable. `client` permite usarla dentro de una transacción. */
    async log({ actorType, actorId = null, action, targetType = null, targetId = null, ip = null, details = null }, client = db) {
      try {
        await client.query(
          `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, ip, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [actorType, actorId, action, targetType, targetId == null ? null : String(targetId), ip, details ? JSON.stringify(details) : null],
        );
      } catch (err) {
        if (client !== db) throw err;
        logger.error({ err, action }, 'No se pudo escribir la auditoría');
      }
    },
  };
}
