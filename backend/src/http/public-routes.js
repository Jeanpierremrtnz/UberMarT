import { Router } from 'express';
import { safeEqual } from '../lib/crypto.js';
import { notFound } from '../lib/errors.js';
import { limiter } from './middleware.js';

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_TEXT = {
  searching: 'Buscando conductor',
  accepted: 'Conductor en camino',
  arrived: 'Conductor en el punto de recogida',
  in_progress: 'Viaje en curso',
  completed: 'Viaje finalizado',
  cancelled: 'Viaje cancelado',
  expired: 'Viaje no asignado',
};

function page(title, body, { refresh } = {}) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/admin/public.css"></head>
<body><main class="card">${body}</main></body></html>`;
}

/** Rutas públicas: salud, seguimiento compartido y retorno/webhook de pagos. */
export function publicRoutes({ services, config, db }) {
  const r = Router();
  const scale = config.rateLimitScale;

  r.get('/healthz', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });

  // Link de seguimiento que el usuario comparte con su familia (expira al terminar el viaje).
  r.get('/s/:token', limiter({ windowMs: 60_000, limit: 30, scale }), async (req, res) => {
    const v = await services.trips.sharedView(req.params.token);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    if (!v) return res.status(404).send(page('Enlace no válido', '<h1>Enlace no válido</h1><p>Este enlace no existe o ya expiró.</p>'));
    if (!v.active) return res.send(page('Viaje terminado', `<h1>${escapeHtml(STATUS_TEXT[v.status])}</h1><p>El seguimiento ya no está disponible.</p>`));
    const loc = v.location
      ? `<p><a class="btn" href="https://www.openstreetmap.org/?mlat=${v.location.lat}&amp;mlon=${v.location.lng}#map=18/${v.location.lat}/${v.location.lng}" rel="noopener noreferrer" target="_blank">Ver ubicación actual en el mapa</a></p>
         <p class="muted">Actualizado: ${escapeHtml(new Date(v.location.at).toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil' }))}</p>`
      : '<p class="muted">Ubicación aún no disponible.</p>';
    const driver = v.driver
      ? `<p><strong>Conductor:</strong> ${escapeHtml(v.driver.firstName)}<br><strong>Placa:</strong> ${escapeHtml(v.driver.plate)}<br><strong>Moto:</strong> ${escapeHtml(v.driver.moto)}</p>`
      : '';
    return res.send(page('Seguimiento de viaje', `<h1>${escapeHtml(STATUS_TEXT[v.status])}</h1>${driver}
      <p><strong>Destino:</strong> ${escapeHtml(v.destination ?? '—')}</p>${loc}
      <p class="muted">Emergencias: llama al 911 (ECU 911).</p>`, { refresh: 15 }));
  });

  // Retorno desde Payphone tras pagar: se confirma servidor-a-servidor antes de acreditar.
  r.get('/api/payments/payphone/return', limiter({ windowMs: 60_000, limit: 30, scale }), async (req, res) => {
    const { id, clientTransactionId, cancelled } = req.query;
    res.set('Cache-Control', 'no-store');
    if (cancelled) {
      await services.topups.cancelGatewayTopup(String(clientTransactionId ?? ''));
      return res.send(page('Pago cancelado', '<h1>Pago cancelado</h1><p>No se realizó ningún cobro. Puedes volver a la app.</p>'));
    }
    const result = await services.topups.confirmGatewayPayment({
      transactionId: String(id ?? ''),
      clientTransactionId: String(clientTransactionId ?? ''),
      source: 'return',
    });
    const ok = result.status === 'approved';
    return res.send(page(ok ? 'Recarga exitosa' : 'Pago no completado', ok
      ? `<h1>¡Recarga exitosa!</h1><p>Se acreditaron <strong>$${(result.amountCents / 100).toFixed(2)}</strong> a tu billetera.</p><p><a class="btn" href="${escapeHtml(config.appDeepLink)}wallet">Volver a la app</a></p>`
      : '<h1>Pago no completado</h1><p>Si se realizó un cobro, se acreditará automáticamente o será reversado por la pasarela.</p>'));
  });

  // Webhook ("notificación externa") de Payphone. La URL incluye un secreto
  // y además el pago se re-confirma con la API antes de acreditar.
  r.post('/api/payments/payphone/notify/:secret', limiter({ windowMs: 60_000, limit: 120, scale }), async (req, res) => {
    if (!config.payphone.notifySecret || !safeEqual(req.params.secret, config.payphone.notifySecret)) throw notFound();
    const b = req.body ?? {};
    const transactionId = b.TransactionId ?? b.transactionId ?? b.id;
    const clientTransactionId = b.ClientTransactionId ?? b.clientTransactionId ?? b.clientTxId;
    const result = await services.topups.confirmGatewayPayment({
      transactionId: String(transactionId ?? ''),
      clientTransactionId: String(clientTransactionId ?? ''),
      source: 'webhook',
    });
    res.json({ received: true, status: result.status });
  });

  return r;
}
