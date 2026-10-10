import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { adminSession, approvedDriver, bootServer, client, fakeImage, imageForm, signup } from '../helpers.js';

const NOTIFY_SECRET = 'n'.repeat(40);
const confirmations = new Map();

async function fakeFetch(url, init) {
  const u = String(url);
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.endsWith('/api/button/Prepare')) {
    const body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer pp-token');
    return json({ paymentId: `pay-${body.clientTransactionId.slice(0, 6)}`, payWithCard: 'https://pay.example/card', payWithPayPhone: 'https://pay.example/app' });
  }
  if (u.endsWith('/api/button/V2/Confirm')) {
    const body = JSON.parse(init.body);
    return json(confirmations.get(body.id) ?? { statusCode: 2, transactionStatus: 'Canceled' });
  }
  throw new Error(`red bloqueada en pruebas: ${u}`);
}

let srv;
let api;
before(async () => {
  srv = await bootServer({
    fetch: fakeFetch,
    env: { PAYPHONE_TOKEN: 'pp-token', PAYPHONE_STORE_ID: 'store-1', PAYPHONE_NOTIFY_SECRET: NOTIFY_SECRET },
  });
  api = client(srv.url);
});
after(() => srv?.close());

const topup = async (driver, fields, image) =>
  api.postForm('/api/wallet/topups', imageForm(fields, image === undefined ? await fakeImage() : image), { token: driver.token });

test('PASO 1: campos clave obligatorios (referencia, monto, banco y foto)', async () => {
  const d = await approvedDriver(api, srv);
  const missingRef = await topup(d, { bank: 'pichincha', amountCents: 1000, reference: '' });
  assert.equal(missingRef.status, 400);
  const badRef = await topup(d, { bank: 'pichincha', amountCents: 1000, reference: '12' });
  assert.equal(badRef.body.error.code, 'REFERENCE_INVALID');
  const noPhoto = await topup(d, { bank: 'pichincha', amountCents: 1000, reference: '55667788' }, null);
  assert.equal(noPhoto.body.error.code, 'IMAGE_REQUIRED');
  const badBank = await topup(d, { bank: 'banco-falso', amountCents: 1000, reference: '55667788' });
  assert.equal(badBank.body.error.code, 'BANK_INVALID');
  const badAmount = await topup(d, { bank: 'deuna', amountCents: 50, reference: '55667788' });
  assert.equal(badAmount.body.error.code, 'AMOUNT_INVALID');
  const notImage = await api.postForm('/api/wallet/topups', imageForm({ bank: 'deuna', amountCents: 1000, reference: '55667788' }, Buffer.from('<?php echo 1; ?>')), { token: d.token });
  assert.equal(notImage.body.error.code, 'IMAGE_INVALID');
  const ok = await topup(d, { bank: 'deuna', amountCents: 1000, reference: '55667788' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'pending');
});

test('PASO 1: filtro antiduplicados — otro conductor no puede reutilizar la referencia ni la imagen', async () => {
  const a = await approvedDriver(api, srv);
  const b = await approvedDriver(api, srv);
  const image = await fakeImage();
  const first = await topup(a, { bank: 'pichincha', amountCents: 2000, reference: '0098765432' }, image);
  assert.equal(first.status, 201);

  for (const variant of ['98765432', '0098-765-432', ' 0098 765 432 ', '000098765432']) {
    const dup = await topup(b, { bank: 'deuna', amountCents: 2000, reference: variant });
    assert.equal(dup.status, 409, `variante ${variant}`);
    assert.equal(dup.body.error.code, 'REFERENCE_ALREADY_USED');
  }
  const sameImage = await topup(b, { bank: 'pichincha', amountCents: 2000, reference: '11112222' }, image);
  assert.equal(sameImage.body.error.code, 'RECEIPT_ALREADY_USED');

  const check = await api.get('/api/wallet/topups/check-reference?reference=98765432', { token: b.token });
  assert.deepEqual(check.body, { available: false });
  const free = await api.get('/api/wallet/topups/check-reference?reference=44445555', { token: b.token });
  assert.deepEqual(free.body, { available: true });

  const attempts = await srv.ctx.db.one(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'topup.duplicate_reference_attempt' AND actor_id = $1`, [b.id]);
  assert.equal(attempts.n, 4, 'cada intento queda auditado');
});

test('PASO 1: carrera — dos envíos simultáneos con la misma referencia, solo uno gana', async () => {
  const a = await approvedDriver(api, srv);
  const b = await approvedDriver(api, srv);
  const [ra, rb] = await Promise.all([
    topup(a, { bank: 'pichincha', amountCents: 500, reference: 'RACE12345' }),
    topup(b, { bank: 'pichincha', amountCents: 500, reference: 'RACE12345' }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [201, 409]);
});

test('solo conductores aprobados pueden recargar', async () => {
  const p = await signup(api, srv);
  const r = await topup(p, { bank: 'pichincha', amountCents: 1000, reference: '99990000' });
  assert.equal(r.status, 403);
});

test('PASO 2: panel — aprobar acredita el saldo una sola vez y queda en el libro contable', async () => {
  const d = await approvedDriver(api, srv);
  const admin = await adminSession(api, srv, 'finance');
  const t = await topup(d, { bank: 'pichincha', amountCents: 1500, reference: 'APR-0001' });

  const queue = await api.get('/api/admin/topups/queue', { headers: admin.headers });
  const item = queue.body.items.find((x) => x.id === t.body.id);
  assert.equal(item.amountCents, 1500);
  assert.equal(item.driver.plate, d.plate);
  const img = await fetch(`${srv.url}${item.receiptUrl}`, { headers: admin.headers });
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.headers.get('cache-control'), 'no-store');

  const [r1, r2] = await Promise.all([
    api.post(`/api/admin/topups/${t.body.id}/approve`, {}, { headers: admin.headers }),
    api.post(`/api/admin/topups/${t.body.id}/approve`, {}, { headers: admin.headers }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], 'doble clic no acredita dos veces');

  const wallet = await api.get('/api/wallet', { token: d.token });
  assert.equal(wallet.body.balanceCents, 1500);
  assert.equal(wallet.body.entries[0].kind, 'topup');
  const integrity = await api.get('/api/admin/wallets/integrity', { headers: admin.headers });
  assert.equal(integrity.body.ok, true);

  await assert.rejects(
    srv.ctx.db.query('UPDATE wallet_entries SET amount_cents = 999999'),
    /solo-anexar/,
    'el libro contable no se puede modificar',
  );
});

test('PASO 2: seguridad del panel — CSRF, roles y sesión', async () => {
  const d = await approvedDriver(api, srv);
  const t = await topup(d, { bank: 'pichincha', amountCents: 800, reference: 'SEC-0001' });
  const finance = await adminSession(api, srv, 'finance');
  const ops = await adminSession(api, srv, 'operations');

  const noCsrf = await api.post(`/api/admin/topups/${t.body.id}/approve`, {}, { headers: { Cookie: finance.cookie } });
  assert.equal(noCsrf.status, 403, 'sin token CSRF no se puede aprobar');
  const wrongRole = await api.post(`/api/admin/topups/${t.body.id}/approve`, {}, { headers: ops.headers });
  assert.equal(wrongRole.status, 403, 'operaciones no aprueba dinero');
  const noSession = await api.get('/api/admin/topups/queue');
  assert.equal(noSession.status, 401);
  const appToken = await api.get('/api/admin/topups/queue', { token: d.token });
  assert.equal(appToken.status, 401, 'un token de la app no sirve en el panel');

  const badTotp = await api.post('/api/admin/auth/login', { email: finance.email, password: finance.password, totp: '123456' });
  assert.equal(badTotp.status, 401);
  const badPass = await api.post('/api/admin/auth/login', { email: finance.email, password: 'incorrecta-123A', totp: '123456' });
  assert.equal(badPass.status, 401);
  const ghost = await api.post('/api/admin/auth/login', { email: 'nadie@ubermart.test', password: 'x', totp: '123456' });
  assert.equal(ghost.status, 401, 'mismo error para correos inexistentes');
});

test('PASO 2: rechazos — referencia mal digitada libera la referencia; foto ilegible permite reenviar', async () => {
  const d = await approvedDriver(api, srv);
  const other = await approvedDriver(api, srv);
  const admin = await adminSession(api, srv, 'owner');

  const typo = await topup(d, { bank: 'pichincha', amountCents: 1000, reference: 'TYPO7777' });
  await api.post(`/api/admin/topups/${typo.body.id}/reject`, { reason: 'referencia_incorrecta' }, { headers: admin.headers });
  const reuse = await topup(other, { bank: 'pichincha', amountCents: 1000, reference: 'TYPO7777' });
  assert.equal(reuse.status, 201, 'la referencia mal digitada queda libre para su dueño real');

  const blurry = await topup(d, { bank: 'deuna', amountCents: 1200, reference: 'BLUR8888' });
  const rej = await api.post(`/api/admin/topups/${blurry.body.id}/reject`, { reason: 'ilegible', note: 'Toma otra foto' }, { headers: admin.headers });
  assert.equal(rej.body.canResubmit, true);
  const stolen = await api.postForm(`/api/wallet/topups/${blurry.body.id}/resubmit`, imageForm({}, await fakeImage()), { token: other.token });
  assert.equal(stolen.status, 404, 'otro conductor no puede tocar recargas ajenas');
  const again = await api.postForm(`/api/wallet/topups/${blurry.body.id}/resubmit`, imageForm({}, await fakeImage()), { token: d.token });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, 'pending');
  const stillReserved = await topup(other, { bank: 'deuna', amountCents: 1200, reference: 'BLUR8888' });
  assert.equal(stillReserved.status, 409);
});

test('PASO 2: rechazo por fraude suspende al conductor', async () => {
  const d = await approvedDriver(api, srv);
  const admin = await adminSession(api, srv, 'finance');
  const t = await topup(d, { bank: 'pichincha', amountCents: 5000, reference: 'FRAUD999' });
  await api.post(`/api/admin/topups/${t.body.id}/reject`, { reason: 'fraude' }, { headers: admin.headers });
  const row = await srv.ctx.db.one('SELECT kyc_status FROM drivers WHERE user_id = $1', [d.id]);
  assert.equal(row.kyc_status, 'suspended');
  assert.equal((await api.get('/api/wallet', { token: d.token })).status, 403);
});

test('conciliación: el estado de cuenta confirma referencia + monto exactos', async () => {
  const d = await approvedDriver(api, srv);
  const admin = await adminSession(api, srv, 'finance');
  const good = await topup(d, { bank: 'pichincha', amountCents: 2500, reference: '000555111' });
  const liar = await topup(d, { bank: 'pichincha', amountCents: 9000, reference: '555222' });
  const csv = 'Fecha;Documento;Concepto;Crédito\n01/10/2026;555111;Transferencia;25,00\n01/10/2026;555222;Transferencia;5,00\n01/10/2026;777;Pago;-3,00\n';
  const imp = await api.post('/api/admin/bank-statements', { csv }, { headers: admin.headers });
  assert.equal(imp.status, 200);
  assert.equal(imp.body.lines, 2);
  assert.equal(imp.body.matchedTopups, 1);
  const queue = await api.get('/api/admin/topups/queue', { headers: admin.headers });
  assert.equal(queue.body.items.find((x) => x.id === good.body.id).bankConfirmed, true);
  const flagged = queue.body.items.find((x) => x.id === liar.body.id);
  assert.equal(flagged.bankConfirmed, false);
  assert.equal(flagged.bankAmountMismatch, true, 'declaró $90 pero el banco recibió $5');
});

test('PASO 3: Payphone — solo se acredita tras confirmar servidor-a-servidor con monto exacto', async () => {
  const d = await approvedDriver(api, srv);
  const link = await api.post('/api/wallet/topups/payphone', { amountCents: 1000 }, { token: d.token });
  assert.equal(link.status, 201);
  assert.equal(link.body.payWithCardUrl, 'https://pay.example/card');
  const clientTransactionId = link.body.topupId;

  // Atacante llama al retorno inventando un id de transacción: Payphone dice "cancelado".
  const fake = await fetch(`${srv.url}/api/payments/payphone/return?id=1&clientTransactionId=${clientTransactionId}`);
  assert.match(await fake.text(), /no completado/);
  assert.equal((await api.get('/api/wallet', { token: d.token })).body.balanceCents, 0);

  const link2 = await api.post('/api/wallet/topups/payphone', { amountCents: 1000 }, { token: d.token });
  const tx2 = link2.body.topupId;
  // Pago aprobado pero por MENOS dinero del pedido: no se acredita.
  confirmations.set(222, { statusCode: 3, transactionStatus: 'Approved', clientTransactionId: tx2, amount: 100, transactionId: 222 });
  const cheap = await fetch(`${srv.url}/api/payments/payphone/return?id=222&clientTransactionId=${tx2}`);
  assert.match(await cheap.text(), /no completado/);
  assert.equal((await api.get('/api/wallet', { token: d.token })).body.balanceCents, 0);

  const link3 = await api.post('/api/wallet/topups/payphone', { amountCents: 1000 }, { token: d.token });
  const tx3 = link3.body.topupId;
  confirmations.set(333, { statusCode: 3, transactionStatus: 'Approved', clientTransactionId: tx3, amount: 1000, transactionId: 333, authorizationCode: 'A1' });
  const okPage = await fetch(`${srv.url}/api/payments/payphone/return?id=333&clientTransactionId=${tx3}`);
  assert.match(await okPage.text(), /Recarga exitosa/);
  // El webhook llega después con el mismo pago: no duplica.
  const hook = await api.post(`/api/payments/payphone/notify/${NOTIFY_SECRET}`, { TransactionId: 333, ClientTransactionId: tx3 });
  assert.equal(hook.status, 200);
  assert.equal((await api.get('/api/wallet', { token: d.token })).body.balanceCents, 1000);

  const badSecret = await api.post('/api/payments/payphone/notify/secreto-falso', { TransactionId: 333, ClientTransactionId: tx3 });
  assert.equal(badSecret.status, 404);
});
