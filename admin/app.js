// Panel administrativo UberMarT. Sin dependencias externas y sin innerHTML con
// datos de usuarios (todo el contenido dinámico se inserta como texto).

const $ = (sel) => document.querySelector(sel);
const state = { csrf: null, admin: null, queue: [], current: 0, busy: false, tab: 'topups', events: null };

const REJECT_REASONS = [
  ['ilegible', 'Foto ilegible'],
  ['monto_incorrecto', 'Monto no coincide'],
  ['referencia_incorrecta', 'Referencia mal digitada'],
  ['no_acreditado', 'Dinero no llegó al banco'],
  ['duplicado', 'Comprobante duplicado'],
  ['fraude', 'Fraude (suspende al conductor)'],
];
const DOC_NAMES = {
  cedula_front: 'Cédula (frente)', cedula_back: 'Cédula (reverso)', license_front: 'Licencia (frente)',
  license_back: 'Licencia (reverso)', vehicle_registration: 'Matrícula', criminal_record: 'Antecedentes penales',
  selfie: 'Selfie', moto_photo: 'Foto de la moto',
};
const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const fmtDate = (iso) => new Date(iso).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Sesión vencida');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Error ${res.status}`);
  return data;
}

// ---------- Sesión ----------
function showLogin() {
  state.events?.close();
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

async function enterApp(admin, csrf) {
  state.admin = admin;
  state.csrf = csrf;
  $('#who').textContent = `${admin.fullName} · ${admin.role}`;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  const visible = {
    topups: ['owner', 'finance'], drivers: ['owner', 'operations'], merchants: ['owner', 'operations', 'finance'],
    sos: ['owner', 'operations'], pricing: ['owner', 'finance', 'operations'],
  };
  for (const btn of document.querySelectorAll('#tabs .tab')) btn.hidden = !visible[btn.dataset.tab].includes(admin.role);
  const first = [...document.querySelectorAll('#tabs .tab')].find((b) => !b.hidden);
  switchTab(first.dataset.tab);
  connectEvents();
  refreshBadges();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const out = await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password'), totp: f.get('totp') } });
    e.target.reset();
    await enterApp(out.admin, out.csrfToken);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.csrf = null;
  showLogin();
});

// ---------- Pestañas ----------
function switchTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll('#tabs .tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.id !== `tab-${tab}`;
  ({ topups: loadQueue, drivers: loadDrivers, merchants: loadMerchants, sos: loadSos, pricing: loadPricing })[tab]();
}
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (btn) switchTab(btn.dataset.tab);
});

// ---------- Eventos en vivo ----------
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch { /* sin audio */ }
}

function connectEvents() {
  state.events?.close();
  state.events = new EventSource('/api/admin/events');
  state.events.addEventListener('sos', () => {
    beep();
    refreshBadges();
    if (state.tab === 'sos') loadSos();
    document.title = '🚨 SOS · UberMarT';
  });
  state.events.addEventListener('topup:new', () => {
    refreshBadges();
    if (state.tab === 'topups' && !$('#topup-empty').hidden) loadQueue();
  });
  state.events.addEventListener('driver:submitted', refreshBadges);
  state.events.addEventListener('merchant:submitted', refreshBadges);
  state.events.addEventListener('order:no_driver', () => {
    beep();
    alert('Un pedido de comida no consiguió motorizado. Revisa con el local y el cliente.');
  });
}

async function refreshBadges() {
  const role = state.admin?.role;
  if (['owner', 'finance'].includes(role)) {
    api('/topups/queue?limit=1').then((q) => { $('#badge-topups').textContent = q.total || ''; }).catch(() => {});
  }
  if (['owner', 'operations'].includes(role)) {
    api('/drivers?status=submitted').then((l) => { $('#badge-drivers').textContent = l.length || ''; }).catch(() => {});
    api('/incidents?status=open').then((l) => { $('#badge-sos').textContent = l.length || ''; }).catch(() => {});
    api('/merchants?status=submitted').then((l) => { $('#badge-merchants').textContent = l.length || ''; }).catch(() => {});
  }
}

// ---------- Recargas: aprobación rápida ----------
async function loadQueue() {
  const q = await api('/topups/queue?limit=50');
  state.queue = q.items;
  state.current = 0;
  $('#queue-count').textContent = q.total ? `(${q.total})` : '';
  $('#badge-topups').textContent = q.total || '';
  renderTopup();
}

function renderTopup() {
  const t = state.queue[state.current];
  $('#topup-empty').hidden = Boolean(t);
  $('#topup-review').hidden = !t;
  $('#reject-box').hidden = true;
  $('#topup-msg').textContent = '';
  if (!t) return;
  $('#receipt-img').src = t.receiptUrl;
  const next = state.queue[state.current + 1];
  if (next) new Image().src = next.receiptUrl;
  $('#f-amount').textContent = money(t.amountCents);
  $('#f-reference').textContent = t.reference;
  $('#f-bank').textContent = t.bankName;
  $('#f-driver').textContent = `${t.driver.fullName} · ${t.driver.phone}`;
  $('#f-plate').textContent = t.driver.plate ?? '—';
  $('#f-date').textContent = fmtDate(t.createdAt) + (t.resubmissions ? ` · reenvío #${t.resubmissions}` : '');
  $('#f-history').textContent = `${t.history.approved} aprobadas · ${t.history.rejected} rechazadas`;
  const flag = $('#bank-flag');
  if (t.bankConfirmed) {
    flag.className = 'flag ok';
    flag.textContent = '✓ Confirmado en el estado de cuenta (referencia y monto coinciden)';
  } else if (t.bankAmountMismatch) {
    flag.className = 'flag bad';
    flag.textContent = '⚠ La referencia existe en el banco pero con OTRO monto';
  } else {
    flag.className = 'flag warn';
    flag.textContent = 'Sin confirmar en banco: verifica en tu banca o importa el estado de cuenta';
  }
}

async function decide(action, body) {
  const t = state.queue[state.current];
  if (!t || state.busy) return;
  state.busy = true;
  for (const b of document.querySelectorAll('.facts .btn')) b.disabled = true;
  try {
    await api(`/topups/${t.id}/${action}`, { method: 'POST', body });
    state.queue.splice(state.current, 1);
    const left = Math.max(0, Number($('#badge-topups').textContent || 1) - 1);
    $('#badge-topups').textContent = left || '';
    $('#queue-count').textContent = left ? `(${left})` : '';
    if (!state.queue.length) await loadQueue();
    else renderTopup();
  } catch (err) {
    $('#topup-msg').textContent = err.message;
    if (/procesada/.test(err.message)) {
      state.queue.splice(state.current, 1);
      renderTopup();
    }
  } finally {
    state.busy = false;
    for (const b of document.querySelectorAll('.facts .btn')) b.disabled = false;
  }
}

function openReject() {
  $('#reject-box').hidden = false;
  $('#reject-note').value = '';
}

$('#reject-reasons').append(...REJECT_REASONS.map(([code, label], i) =>
  h('button', { class: 'btn small', type: 'button', onclick: () => decide('reject', { reason: code, note: $('#reject-note').value || undefined }) }, `${i + 1}. ${label}`)));
$('#btn-approve').addEventListener('click', () => decide('approve'));
$('#btn-reject').addEventListener('click', openReject);
$('#receipt-img').addEventListener('click', () => {
  $('#zoom-img').src = $('#receipt-img').src;
  $('#zoom').showModal();
});

document.addEventListener('keydown', (e) => {
  if (state.tab !== 'topups' || $('#topup-review').hidden || e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey) return;
  const key = e.key.toLowerCase();
  if (key === 'a') decide('approve');
  else if (key === 'r') openReject();
  else if (key === 'escape') $('#reject-box').hidden = true;
  else if (!$('#reject-box').hidden && /^[1-6]$/.test(key)) {
    decide('reject', { reason: REJECT_REASONS[Number(key) - 1][0], note: $('#reject-note').value || undefined });
  }
});

$('#bank-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = new FormData(e.target).get('file');
  $('#bank-result').textContent = 'Importando…';
  try {
    const out = await api('/bank-statements', { method: 'POST', body: { csv: await file.text() } });
    $('#bank-result').textContent = `${out.lines} créditos leídos · ${out.imported} nuevos · ${out.matchedTopups} recargas confirmadas`;
    loadQueue();
  } catch (err) {
    $('#bank-result').textContent = err.message;
  }
});

// ---------- Conductores ----------
async function loadDrivers() {
  const list = await api(`/drivers?status=${$('#driver-status').value}`);
  const ul = $('#driver-list');
  ul.replaceChildren(...list.map((d) => h('li', { onclick: (e) => openDriver(d.driverId, e.currentTarget) },
    h('strong', {}, d.fullName ?? 'Sin nombre'), h('br'), h('span', { class: 'muted' }, `${d.plate ?? '—'} · ${d.moto} · ${d.phone}`))));
  if (!list.length) ul.append(h('li', { class: 'muted' }, 'Sin registros'));
  $('#driver-detail').replaceChildren(h('p', { class: 'muted' }, 'Selecciona un conductor.'));
}
$('#driver-status').addEventListener('change', loadDrivers);

async function openDriver(id, li) {
  for (const x of document.querySelectorAll('#driver-list li')) x.classList.toggle('selected', x === li);
  const d = await api(`/drivers/${id}`);
  const note = h('input', { placeholder: 'Motivo (obligatorio para rechazar o suspender)', maxlength: 300 });
  const msg = h('p', { class: 'error' });
  const act = (decision) => async () => {
    try {
      await api(`/drivers/${id}/${decision}`, { method: 'POST', body: { note: note.value || undefined } });
      loadDrivers();
      refreshBadges();
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  $('#driver-detail').replaceChildren(...[
    h('h3', {}, d.fullName),
    h('p', {}, `Cédula: ${d.cedula ?? '—'} · Teléfono: ${d.phone}`),
    h('p', {}, `Licencia: ${d.licenseNumber ?? '—'} (vence ${d.licenseExpiresOn ?? '—'})`),
    h('p', {}, `Moto: ${[d.moto.brand, d.moto.model, d.moto.year, d.moto.color].filter(Boolean).join(' ')} · Placa ${d.plate}`),
    d.gpsAnomalies ? h('p', { class: 'flag warn' }, `Anomalías de GPS registradas: ${d.gpsAnomalies}`) : null,
    d.note ? h('p', { class: 'muted' }, `Nota: ${d.note}`) : null,
    h('p', { class: 'muted' }, 'Compara la selfie con la foto de la cédula, verifica la vigencia de la licencia tipo A y el código del certificado de antecedentes en el portal oficial.'),
    h('div', { class: 'docs' }, d.documents.map((doc) => h('figure', {},
      h('img', { src: doc.url, alt: DOC_NAMES[doc.kind], onclick: (e) => { $('#zoom-img').src = e.target.src; $('#zoom').showModal(); } }),
      h('figcaption', {}, DOC_NAMES[doc.kind])))),
    note,
    h('div', { class: 'row' },
      ['submitted', 'suspended'].includes(d.status) ? h('button', { class: 'btn approve', onclick: act('approve') }, 'Aprobar') : null,
      d.status === 'submitted' ? h('button', { class: 'btn reject', onclick: act('reject') }, 'Rechazar') : null,
      ['approved', 'submitted'].includes(d.status) ? h('button', { class: 'btn', onclick: act('suspend') }, 'Suspender') : null),
    msg,
  ].filter(Boolean));
}

// ---------- Comercios ----------
const MERCHANT_DOCS = {
  ruc: 'Certificado RUC', permiso_funcionamiento: 'Permiso de funcionamiento', cedula_owner: 'Cédula del dueño', storefront: 'Fachada',
};

async function loadMerchants() {
  const list = await api(`/merchants?status=${$('#merchant-status').value}`);
  const ul = $('#merchant-list');
  ul.replaceChildren(...list.map((m) => h('li', { onclick: (e) => openMerchant(m.id, e.currentTarget) },
    h('strong', {}, m.name), h('br'),
    h('span', { class: 'muted' }, `RUC ${m.ruc} · ${m.category}${m.owedCents > 0 ? ` · debe ${money(m.owedCents)}` : ''}`))));
  if (!list.length) ul.append(h('li', { class: 'muted' }, 'Sin registros'));
  $('#merchant-detail').replaceChildren(h('p', { class: 'muted' }, 'Selecciona un local.'));
}
$('#merchant-status').addEventListener('change', loadMerchants);

async function openMerchant(id, li) {
  for (const x of document.querySelectorAll('#merchant-list li')) x.classList.toggle('selected', x === li);
  const role = state.admin.role;
  const canReview = ['owner', 'operations'].includes(role);
  const canFinance = ['owner', 'finance'].includes(role);
  const m = canReview ? await api(`/merchants/${id}`) : null;
  const msg = h('p', { class: 'error' });
  const children = [];
  if (m) {
    const note = h('input', { placeholder: 'Motivo u observación (obligatorio para rechazar o suspender)', maxlength: 300 });
    const commission = h('input', { type: 'number', min: 0, max: 50, step: '0.5', value: m.commissionPercent });
    const act = (decision) => async () => {
      try {
        await api(`/merchants/${id}/${decision}`, {
          method: 'POST',
          body: { note: note.value || undefined, ...(decision === 'approve' ? { commissionBps: Math.round(Number(commission.value) * 100) } : {}) },
        });
        loadMerchants();
        refreshBadges();
      } catch (err) {
        msg.textContent = err.message;
      }
    };
    children.push(
      h('h3', {}, m.name),
      h('p', {}, `${m.category} · RUC ${m.ruc} · ${m.addressLabel}`),
      h('p', {}, `Dueño: ${m.ownerName} · Cédula ${m.ownerCedula} · ${m.phone} · ${m.ownerEmail ?? ''}`),
      h('p', {}, h('a', { class: 'btn small', target: '_blank', rel: 'noopener noreferrer', href: `https://www.openstreetmap.org/?mlat=${m.location.lat}&mlon=${m.location.lng}#map=18/${m.location.lat}/${m.location.lng}` }, 'Ver ubicación del local')),
      m.reviewNote ? h('p', { class: 'muted' }, `Nota: ${m.reviewNote}`) : null,
      h('p', { class: 'muted' }, 'Verifica el RUC en el portal del SRI, que el permiso esté vigente, que la cédula coincida con el dueño y que la fachada corresponda a la dirección.'),
      h('div', { class: 'docs' }, m.documents.map((d) => h('figure', {},
        h('img', { src: d.url, alt: MERCHANT_DOCS[d.kind], onclick: (e) => { $('#zoom-img').src = e.target.src; $('#zoom').showModal(); } }),
        h('figcaption', {}, MERCHANT_DOCS[d.kind])))),
      h('h3', {}, `Productos (${m.menu.length})`),
      h('ul', { class: 'items' }, m.menu.slice(0, 50).map((i) => h('li', {}, `${i.name} · ${money(i.priceCents)}${i.isAvailable ? '' : ' (agotado)'}`))),
      h('div', { class: 'row' }, h('label', { class: 'narrow' }, 'Comisión % ', commission)),
      note,
      h('div', { class: 'row' },
        ['submitted', 'suspended'].includes(m.status) ? h('button', { class: 'btn approve', onclick: act('approve') }, 'Aprobar') : null,
        m.status === 'submitted' ? h('button', { class: 'btn reject', onclick: act('reject') }, 'Rechazar') : null,
        ['approved', 'submitted'].includes(m.status) ? h('button', { class: 'btn', onclick: act('suspend') }, 'Suspender') : null),
      h('h3', {}, `Cuenta: debe ${money(Math.max(0, m.ledger.owedCents))}`),
    );
  } else {
    children.push(h('p', { class: 'muted' }, 'Tu rol solo puede registrar pagos de comisiones.'));
  }
  if (canFinance) {
    const amount = h('input', { inputmode: 'decimal', placeholder: 'Monto recibido (ej. 25.00)' });
    const pnote = h('input', { placeholder: 'Referencia del pago', maxlength: 300 });
    children.push(h('div', { class: 'row' }, amount, pnote, h('button', { class: 'btn small primary', onclick: async () => {
      const cents = Math.round(Number(String(amount.value).replace(',', '.')) * 100);
      if (!cents || cents < 1) {
        msg.textContent = 'Monto inválido';
        return;
      }
      try {
        const l = await api(`/merchants/${id}/payments`, { method: 'POST', body: { amountCents: cents, note: pnote.value || undefined } });
        msg.textContent = `Pago registrado. Saldo pendiente: ${money(Math.max(0, l.owedCents))}`;
        loadMerchants();
      } catch (err) {
        msg.textContent = err.message;
      }
    } }, 'Registrar pago')));
  }
  children.push(msg);
  $('#merchant-detail').replaceChildren(...children.filter(Boolean));
}

// ---------- SOS ----------
async function loadSos() {
  const list = await api(`/incidents?status=${$('#sos-status').value}`);
  $('#sos-list').replaceChildren(...list.map((i) => h('li', { class: i.status === 'open' ? 'sos-open' : '' },
    h('strong', {}, `${i.kind === 'sos' ? '🚨 Botón de pánico' : 'Reporte'} · ${i.role === 'driver' ? 'Conductor' : 'Pasajero'}`),
    h('span', {}, `${i.user.fullName ?? 'Sin nombre'} · ${i.user.phone} · ${fmtDate(i.createdAt)}`),
    i.message ? h('span', { class: 'muted' }, i.message) : null,
    h('div', { class: 'row' },
      i.location ? h('a', { class: 'btn small', target: '_blank', rel: 'noopener noreferrer', href: `https://www.openstreetmap.org/?mlat=${i.location.lat}&mlon=${i.location.lng}#map=18/${i.location.lat}/${i.location.lng}` }, 'Ver ubicación') : null,
      h('a', { class: 'btn small', href: `tel:${i.user.phone}` }, 'Llamar'),
      i.status === 'open' ? h('button', { class: 'btn small', onclick: () => api(`/incidents/${i.id}/acknowledge`, { method: 'POST' }).then(loadSos) }, 'Atendiendo') : null,
      i.status !== 'resolved' ? h('button', { class: 'btn small primary', onclick: () => api(`/incidents/${i.id}/resolve`, { method: 'POST' }).then(() => { loadSos(); refreshBadges(); }) }, 'Resolver') : null))));
  if (!list.length) $('#sos-list').append(h('li', { class: 'muted' }, 'Sin alertas'));
  if ($('#sos-status').value === 'open') document.title = 'UberMarT · Panel';
}
$('#sos-status').addEventListener('change', loadSos);

// ---------- Tarifas ----------
const PRICING_FIELDS = [
  ['baseCents', 'Tarifa base (¢)'], ['perKmCents', 'Costo por km (¢)'], ['perMinCents', 'Costo por minuto (¢)'],
  ['minFareCents', 'Tarifa mínima (¢)'], ['rainSurchargeCents', 'Recargo lluvia (¢)'], ['maxMultiplier', 'Multiplicador máx.'],
  ['roundingStepCents', 'Redondeo (¢)'], ['durationFactor', 'Factor de tiempo moto'], ['quoteTtlSec', 'Validez cotización (s)'],
  ['minTripMeters', 'Viaje mínimo (m)'], ['maxTripMeters', 'Viaje máximo (m)'],
];
const WALLET_FIELDS = [
  ['commissionBps', 'Comisión (puntos base, 1000 = 10%)'], ['minBalanceCents', 'Saldo mínimo para conectarse (¢)'],
  ['topupMinCents', 'Recarga mínima (¢)'], ['topupMaxCents', 'Recarga máxima (¢)'], ['maxPendingTopups', 'Recargas pendientes máx.'],
  ['maxResubmissions', 'Reenvíos máx.'],
];

function fillFields(container, fields, values) {
  container.replaceChildren(...fields.map(([k, label]) => h('label', {}, label,
    h('input', { name: k, type: 'number', step: 'any', value: values[k], required: true }))));
}

function bindSettingsForm(form, key, fields) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = form.querySelector('[data-result]');
    const current = await api(`/settings/${key}`);
    for (const [k] of fields) current[k] = Number(form.elements[k].value);
    try {
      await api(`/settings/${key}`, { method: 'PUT', body: current });
      out.textContent = 'Guardado ✓';
    } catch (err) {
      out.textContent = err.message;
    }
  });
}
bindSettingsForm($('#pricing-form'), 'pricing', PRICING_FIELDS);
bindSettingsForm($('#wallet-form'), 'wallet', WALLET_FIELDS);

async function loadPricing() {
  const [pricing, wallet, accounts, snap] = await Promise.all([
    api('/settings/pricing'), api('/settings/wallet'), api('/settings/topupAccounts'), api('/pricing/snapshot'),
  ]);
  fillFields($('#pricing-fields'), PRICING_FIELDS, pricing);
  fillFields($('#wallet-fields'), WALLET_FIELDS, wallet);
  $('#accounts-json').value = JSON.stringify(accounts.length ? accounts : [
    { bank: 'Banco Pichincha', accountType: 'ahorros', number: '0000000000', holder: 'Nombre del titular', idNumber: '0000000000' },
  ], null, 2);
  $('#weather-now').textContent = `Ahora: ${snap.weather.raining ? '🌧 lloviendo (recargo activo)' : 'sin lluvia'} · fuente: ${snap.weather.source}`;
  $('#time-rule-now').textContent = snap.timeRule.rule ? `${snap.timeRule.rule} (${snap.timeRule.multiplier}×)` : 'Ninguna en este momento';
  $('#zones-body').replaceChildren(...snap.zones.map((z) => h('tr', {},
    h('td', {}, z.name), h('td', {}, z.demand ?? '—'), h('td', {}, z.supply ?? '—'),
    h('td', {}, `${z.multiplier}×`), h('td', {}, `${z.maxMultiplier}×`))));
  const weather = await api('/settings/weather');
  for (const b of document.querySelectorAll('[data-weather]')) b.classList.toggle('active', b.dataset.weather === weather.mode);
}

for (const b of document.querySelectorAll('[data-weather]')) {
  b.addEventListener('click', async () => {
    await api('/settings/weather', { method: 'PUT', body: { mode: b.dataset.weather } }).catch((err) => alert(err.message));
    loadPricing();
  });
}

$('#accounts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = e.target.querySelector('[data-result]');
  try {
    await api('/settings/topupAccounts', { method: 'PUT', body: JSON.parse($('#accounts-json').value) });
    out.textContent = 'Guardado ✓';
  } catch (err) {
    out.textContent = err.message;
  }
});

// ---------- Inicio ----------
api('/auth/me').then((me) => enterApp(me.admin, me.csrfToken)).catch(() => showLogin());
