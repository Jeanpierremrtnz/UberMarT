import { maskPhone } from '../lib/ecuador.js';
import { HttpError } from '../lib/errors.js';

export function createSmsService({ config, logger }) {
  const outbox = [];

  if (config.sms.provider === 'console') {
    return {
      outbox,
      async send(to, body) {
        // Solo desarrollo/pruebas (config.js lo prohíbe en producción).
        outbox.push({ to, body, at: Date.now() });
        if (outbox.length > 200) outbox.shift();
        if (!config.isTest) logger.warn({ to: maskPhone(to) }, `[SMS de desarrollo] ${body}`);
      },
    };
  }

  const { twilioSid, twilioToken, twilioFrom } = config.sms;
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
  return {
    outbox,
    async send(to, body) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(twilioSid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: twilioFrom, Body: body }),
        signal: AbortSignal.timeout(8000),
      }).catch((err) => {
        logger.error({ err }, 'Fallo de red al enviar SMS');
        return null;
      });
      if (!res || !res.ok) {
        logger.error({ status: res?.status, to: maskPhone(to) }, 'El proveedor SMS rechazó el envío');
        throw new HttpError(503, 'SMS_UNAVAILABLE', 'No pudimos enviar el SMS, intenta de nuevo');
      }
    },
  };
}
