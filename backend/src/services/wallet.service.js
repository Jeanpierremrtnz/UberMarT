import { notFound } from '../lib/errors.js';

export function createWalletService({ db, settings }) {
  /**
   * Registra un movimiento y actualiza el saldo en la MISMA transacción.
   * La restricción UNIQUE(kind, ref_type, ref_id) del libro contable hace que
   * un segundo intento con la misma referencia falle y se revierta completo.
   */
  async function post(client, { driverId, amountCents, kind, refType, refId, note = null, adminId = null }) {
    const { rows } = await client.query(
      'UPDATE wallets SET balance_cents = balance_cents + $2, updated_at = now() WHERE driver_id = $1 RETURNING balance_cents',
      [driverId, amountCents],
    );
    if (!rows[0]) throw notFound('Billetera no encontrada');
    await client.query(
      `INSERT INTO wallet_entries (driver_id, amount_cents, balance_after_cents, kind, ref_type, ref_id, note, admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [driverId, amountCents, rows[0].balance_cents, kind, refType, refId, note, adminId],
    );
    return rows[0].balance_cents;
  }

  return {
    post,

    async summary(driverId) {
      const wallet = await db.one('SELECT balance_cents FROM wallets WHERE driver_id = $1', [driverId]);
      if (!wallet) throw notFound('Tu billetera se activa cuando tu cuenta de conductor sea aprobada');
      const { rows } = await db.query(
        `SELECT id, amount_cents, balance_after_cents, kind, ref_type, ref_id, created_at
           FROM wallet_entries WHERE driver_id = $1 ORDER BY id DESC LIMIT 30`,
        [driverId],
      );
      const [walletCfg, accounts] = await Promise.all([settings.get('wallet'), settings.get('topupAccounts')]);
      return {
        balanceCents: wallet.balance_cents,
        minBalanceCents: walletCfg.minBalanceCents,
        commissionPercent: walletCfg.commissionBps / 100,
        canGoOnline: wallet.balance_cents >= walletCfg.minBalanceCents,
        topupLimits: { minCents: walletCfg.topupMinCents, maxCents: walletCfg.topupMaxCents },
        topupAccounts: accounts,
        entries: rows.map((r) => ({
          id: r.id,
          amountCents: r.amount_cents,
          balanceAfterCents: r.balance_after_cents,
          kind: r.kind,
          refType: r.ref_type,
          refId: r.ref_id,
          createdAt: r.created_at,
        })),
      };
    },

    /** Verifica que cada saldo coincida con la suma de su libro contable. */
    async integrityReport() {
      const { rows } = await db.query(
        `SELECT w.driver_id, w.balance_cents, COALESCE(SUM(e.amount_cents), 0)::bigint AS ledger_cents
           FROM wallets w LEFT JOIN wallet_entries e ON e.driver_id = w.driver_id
          GROUP BY w.driver_id, w.balance_cents
         HAVING w.balance_cents <> COALESCE(SUM(e.amount_cents), 0)`,
      );
      const totals = await db.one('SELECT count(*)::int AS wallets, COALESCE(SUM(balance_cents), 0)::bigint AS total_cents FROM wallets');
      return { ok: rows.length === 0, wallets: totals.wallets, totalBalanceCents: totals.total_cents, mismatches: rows };
    },
  };
}
