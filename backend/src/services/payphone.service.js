import { HttpError } from '../lib/errors.js';

/**
 * Cliente de Payphone (Botón de Pagos). Flujo:
 *  1) Prepare: crea la orden y devuelve los links de pago (tarjeta / app Payphone).
 *  2) El conductor paga; Payphone redirige a responseUrl con ?id=&clientTransactionId=.
 *  3) Confirm (V2): el servidor consulta el resultado real. Si no se confirma,
 *     Payphone reversa el cobro automáticamente.
 * Verifica las rutas y campos contra la documentación vigente de tu cuenta
 * Payphone Developer antes de salir a producción.
 */
export function createPayphoneService({ config, logger, fetchImpl = fetch }) {
  const { apiBase, token, storeId, enabled } = config.payphone;

  async function call(path, body) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error({ err, path }, 'Payphone no responde');
      throw new HttpError(502, 'GATEWAY_UNAVAILABLE', 'La pasarela de pago no responde, intenta de nuevo');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      logger.error({ status: res.status, path, data }, 'Payphone devolvió un error');
      throw new HttpError(502, 'GATEWAY_ERROR', 'La pasarela de pago rechazó la operación');
    }
    return data;
  }

  return {
    enabled,

    async prepare({ amountCents, clientTransactionId, reference, responseUrl, cancellationUrl }) {
      const data = await call('/api/button/Prepare', {
        amount: amountCents,
        amountWithoutTax: amountCents,
        amountWithTax: 0,
        tax: 0,
        service: 0,
        tip: 0,
        currency: 'USD',
        clientTransactionId,
        storeId,
        reference,
        responseUrl,
        cancellationUrl,
        timeZone: -5,
      });
      if (!data.payWithCard && !data.payWithPayPhone) {
        throw new HttpError(502, 'GATEWAY_ERROR', 'La pasarela no generó el link de pago');
      }
      return { paymentId: data.paymentId, payWithCard: data.payWithCard, payWithPayPhone: data.payWithPayPhone };
    },

    async confirm({ id, clientTxId }) {
      return call('/api/button/V2/Confirm', { id: Number(id), clientTxId });
    },
  };
}
