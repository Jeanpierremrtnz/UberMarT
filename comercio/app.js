// Panel de comercios UberMarT: registro autogestionado, productos, pedidos en vivo
// y cuenta. Sin dependencias externas y sin innerHTML con datos de usuarios.

const $ = (sel) => document.querySelector(sel);
const state = { csrf: null, profile: null, tab: 'orders', events: null, reg: {} };

const DOCS = {
  ruc: 'Certificado del RUC (SRI)',
  permiso_funcionamiento: 'Permiso de funcionamiento (ARCSA / Municipio)',
  cedula_owner: 'Cédula del dueño',
  storefront: 'Foto de la fachada del local',
};
const STATUS = {
  draft: ['warn', 'Completa tus datos, documentos y al menos un producto, y envía tu local a revisión.'],
  submitted: ['warn', 'Tu local está en revisión. Te avisaremos cuando sea aprobado.'],
  approved: ['ok', 'Local verificado. Abre tu local para recibir pedidos.'],
  rejected: ['bad', 'Tu solicitud fue rechazada. Corrige lo indicado y vuelve a enviarla.'],
  suspended: ['bad', 'Tu local está suspendido. Comunícate con soporte de UberMarT.'],
};
const ORDER_STATUS = {
  placed: 'Nuevo', accepted: 'En preparación', ready: 'Listo para retirar', picked_up: 'En camino',
  delivered: 'Entregado', rejected: 'Rechazado', cancelled: 'Cancelado',
};
const REJECT = [
  ['sin_stock', 'Sin stock'], ['cerrando', 'Estamos cerrando'], ['demasiados_pedidos', 'Demasiados pedidos'],
  ['direccion_fuera_de_zona', 'Dirección fuera de zona'], ['otro', 'Otro motivo'],
];
const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const fmt = (iso) => new Date(iso).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const toCents = (v) => {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(v).trim());
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0')) : null;
};

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

async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(`/api/merchant${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401 && state.csrf) {
    showView('login');
    throw new Error('Sesión vencida');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.details;
    const extra = Array.isArray(detail) ? `: ${detail.map((d) => d.message).join(', ')}` : detail?.missing ? `: ${detail.missing.map((k) => DOCS[k] ?? k).join(', ')}` : '';
    throw new Error((data?.error?.message ?? `Error ${res.status}`) + extra);
  }
  return data;
}

function showView(name) {
  for (const v of ['login', 'register', 'app']) $(`#${v}-view`).hidden = v !== name;
  const hash = name === 'register' ? '#registro' : '';
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);
  if (name !== 'app') state.events?.close();
}

// ---------------- Ingreso ----------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const out = await api('/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password'), totp: f.get('totp') } });
    state.csrf = out.csrfToken;
    e.target.reset();
    await enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  state.csrf = null;
  showView('login');
});

// ---------------- Registro ----------------
function regStep(n) {
  for (let i = 1; i <= 4; i += 1) $(`#reg-step-${i}`).hidden = i !== n;
  for (const li of document.querySelectorAll('.steps li')) li.classList.toggle('active', Number(li.dataset.step) === n);
  $('#reg-error').textContent = '';
}
$('#go-register').addEventListener('click', (e) => {
  e.preventDefault();
  showView('register');
  regStep(1);
});
$('#back-login').addEventListener('click', (e) => {
  e.preventDefault();
  showView('login');
});
$('#go-login').addEventListener('click', () => showView('login'));

$('#reg-step-1').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const out = await api('/register/otp', { method: 'POST', body: { phone: new FormData(e.target).get('phone') } });
    state.reg.challengeId = out.challengeId;
    $('#otp-label').hidden = false;
    $('#otp-continue').hidden = false;
    $('#reg-error').textContent = '';
  } catch (err) {
    $('#reg-error').textContent = err.message;
  }
});
$('#otp-continue').addEventListener('click', () => {
  const code = $('#reg-step-1').elements.code.value.trim();
  if (!/^\d{6}$/.test(code)) {
    $('#reg-error').textContent = 'Ingresa el código de 6 dígitos';
    return;
  }
  state.reg.code = code;
  regStep(2);
});
$('#use-location').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const f = $('#reg-step-2').elements;
      f.lat.value = p.coords.latitude.toFixed(6);
      f.lng.value = p.coords.longitude.toFixed(6);
    },
    () => { $('#reg-error').textContent = 'No se pudo obtener la ubicación; escríbela manualmente.'; },
    { enableHighAccuracy: true, timeout: 10000 },
  );
});
$('#reg-step-2').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  state.reg.business = {
    name: f.get('name').trim(), category: f.get('category'), ruc: f.get('ruc').trim(), addressLabel: f.get('addressLabel').trim(),
    lat: Number(f.get('lat')), lng: Number(f.get('lng')), scheduleText: f.get('scheduleText').trim() || undefined,
  };
  regStep(3);
});
$('#reg-step-3').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('password') !== f.get('password2')) {
    $('#reg-error').textContent = 'Las contraseñas no coinciden';
    return;
  }
  try {
    const out = await api('/register', {
      method: 'POST',
      body: {
        challengeId: state.reg.challengeId,
        code: state.reg.code,
        business: state.reg.business,
        owner: { fullName: f.get('fullName').trim(), cedula: f.get('cedula').trim(), email: f.get('email').trim(), password: f.get('password') },
      },
    });
    $('#totp-secret').textContent = out.totpSecret.replace(/(.{4})/g, '$1 ').trim();
    $('#totp-link').href = out.totpUri;
    state.reg = {};
    e.target.reset();
    regStep(4);
  } catch (err) {
    $('#reg-error').textContent = err.message;
    if (/código/i.test(err.message)) regStep(1);
  }
});

// ---------------- Panel ----------------
async function enterApp() {
  showView('app');
  await loadProfile();
  switchTab(state.profile.status === 'approved' ? 'orders' : 'store');
  connectEvents();
}

async function loadProfile() {
  const p = await api('/profile');
  state.profile = p;
  $('#store-name').textContent = p.name;
  const [cls, text] = STATUS[p.status];
  const banner = $('#status-banner');
  banner.className = `flag ${cls}`;
  banner.textContent = p.reviewNote ? `${text} Observación: ${p.reviewNote}` : text;
  banner.hidden = p.status === 'approved' && p.isOpen;
  $('#open-toggle').checked = p.isOpen;
  $('#open-toggle').disabled = p.status !== 'approved';
  $('#open-label').textContent = p.isOpen ? 'Abierto' : 'Cerrado';
}

$('#open-toggle').addEventListener('change', async (e) => {
  try {
    await api('/store', { method: 'PUT', body: { isOpen: e.target.checked } });
  } catch (err) {
    alert(err.message);
  }
  await loadProfile();
});

function switchTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${tab}`;
  ({ orders: loadOrders, menu: loadMenu, store: loadStore, account: loadAccount })[tab]();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) switchTab(b.dataset.tab);
});

function beep() {
  try {
    const ctx = new AudioContext();
    for (const [i, f] of [[0, 880], [0.35, 1100]]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(ctx.destination);
      o.start(ctx.currentTime + i);
      o.stop(ctx.currentTime + i + 0.25);
    }
  } catch { /* sin audio */ }
}

function connectEvents() {
  state.events?.close();
  state.events = new EventSource('/api/merchant/events');
  state.events.addEventListener('order:new', () => {
    beep();
    document.title = '🔔 Nuevo pedido · UberMarT';
    if (state.tab === 'orders') loadOrders();
  });
  state.events.addEventListener('order:update', () => { if (state.tab === 'orders') loadOrders(); });
  state.events.addEventListener('merchant:status', () => loadProfile());
}
// Respaldo por si la conexión en vivo se corta.
setInterval(() => { if (!$('#app-view').hidden && state.tab === 'orders') loadOrders(); }, 30_000);

// ---------------- Pedidos ----------------
async function loadOrders() {
  const scope = $('#orders-scope').value;
  const list = await api(`/orders?scope=${scope}`);
  $('#badge-orders').textContent = list.filter((o) => o.status === 'placed').length || '';
  if (!list.some((o) => o.status === 'placed')) document.title = 'UberMarT · Comercios';
  const box = $('#orders-list');
  box.replaceChildren(...list.map(orderCard));
  if (!list.length) box.append(h('p', { class: 'empty' }, scope === 'active' ? 'No hay pedidos en curso.' : 'Sin pedidos anteriores.'));
}
$('#orders-scope').addEventListener('change', loadOrders);

function orderCard(o) {
  const msg = h('p', { class: 'error' });
  const run = (path, body) => async () => {
    try {
      await api(`/orders/${o.id}/${path}`, { method: 'POST', body });
      loadOrders();
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  const prep = h('select', {}, [10, 15, 20, 30, 45, 60].map((m) => h('option', { value: m, selected: m === (state.profile?.prepMinutes ?? 15) }, `${m} min`)));
  const reason = h('select', {}, REJECT.map(([v, t]) => h('option', { value: v }, t)));
  return h('article', { class: `card order ${o.status}` },
    h('div', { class: 'row space' }, h('strong', { class: 'mono big' }, `#${o.code}`), h('span', { class: 'pill' }, ORDER_STATUS[o.status])),
    h('p', { class: 'muted' }, `${fmt(o.placedAt)} · Cliente: ${o.customer?.firstName ?? '—'}`),
    h('ul', { class: 'items' }, o.items.map((i) => h('li', {}, h('strong', {}, `${i.qty} × `), i.name, i.note ? h('em', {}, ` — ${i.note}`) : null))),
    o.note ? h('p', { class: 'flag warn' }, `Nota: ${o.note}`) : null,
    h('p', {}, h('strong', {}, `Total productos: ${money(o.subtotalCents)}`), ' · el motorizado te paga en efectivo al retirar'),
    o.driver ? h('p', { class: 'flag ok' }, `Motorizado: ${o.driver.firstName} · Placa ${o.driver.plate} · ${o.driver.moto}`) : null,
    o.status === 'placed' ? h('div', { class: 'row' },
      h('label', {}, 'Preparación ', prep),
      h('button', { class: 'btn approve small', onclick: () => run('accept', { prepMinutes: Number(prep.value) })() }, 'Aceptar'),
      reason,
      h('button', { class: 'btn reject small', onclick: () => run('reject', { reason: reason.value })() }, 'Rechazar')) : null,
    o.status === 'accepted' ? h('button', { class: 'btn approve', onclick: run('ready') }, 'Pedido listo para retirar') : null,
    o.status === 'ready' ? h('p', { class: 'muted' }, 'Entrega el pedido solo al motorizado de la placa indicada.') : null,
    msg);
}

// ---------------- Productos ----------------
async function loadMenu() {
  const items = await api('/menu');
  const grid = $('#menu-list');
  grid.replaceChildren(...items.map((i) => {
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
      const fd = new FormData();
      fd.append('file', e.target.files[0]);
      try {
        await api(`/menu/${i.id}/photo`, { method: 'PUT', form: fd });
        loadMenu();
      } catch (err) {
        alert(err.message);
      }
    } });
    return h('article', { class: `card item ${i.isAvailable ? '' : 'off'}` },
      i.photoUrl ? h('img', { src: i.photoUrl, alt: i.name, loading: 'lazy' }) : h('div', { class: 'ph' }, 'Sin foto'),
      h('strong', {}, i.name), h('span', { class: 'muted' }, `${i.category} · ${money(i.priceCents)}`),
      i.description ? h('span', { class: 'muted small-text' }, i.description) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => file.click() }, i.photoUrl ? 'Cambiar foto' : 'Subir foto'), file,
        h('button', { class: 'btn small', onclick: () => api(`/menu/${i.id}`, { method: 'PUT', body: { isAvailable: !i.isAvailable } }).then(loadMenu) }, i.isAvailable ? 'Agotado' : 'Disponible'),
        h('button', { class: 'btn small', onclick: () => editItem(i) }, 'Editar'),
        h('button', { class: 'btn small', onclick: () => confirm(`¿Eliminar ${i.name}?`) && api(`/menu/${i.id}`, { method: 'DELETE' }).then(loadMenu) }, 'Eliminar')));
  }));
  if (!items.length) grid.append(h('p', { class: 'empty' }, 'Agrega tu primer producto con el formulario de arriba.'));
}

function editItem(i) {
  const f = $('#item-form').elements;
  f.id.value = i.id;
  f.category.value = i.category;
  f.name.value = i.name;
  f.price.value = (i.priceCents / 100).toFixed(2);
  f.description.value = i.description ?? '';
  f.isAvailable.checked = i.isAvailable;
  $('#item-form-title').textContent = 'Editar producto';
  $('#item-cancel').hidden = false;
  $('#item-form').scrollIntoView({ behavior: 'smooth' });
}
function resetItemForm() {
  $('#item-form').reset();
  $('#item-form').elements.id.value = '';
  $('#item-form-title').textContent = 'Agregar producto';
  $('#item-cancel').hidden = true;
}
$('#item-cancel').addEventListener('click', resetItemForm);
$('#item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const priceCents = toCents(f.price.value);
  if (!priceCents) {
    $('#item-msg').textContent = 'Precio inválido (ej. 3.50)';
    return;
  }
  const body = {
    category: f.category.value.trim() || 'General', name: f.name.value.trim(), priceCents,
    description: f.description.value.trim() || undefined, isAvailable: f.isAvailable.checked,
  };
  try {
    if (f.id.value) await api(`/menu/${f.id.value}`, { method: 'PUT', body });
    else await api('/menu', { method: 'POST', body });
    $('#item-msg').textContent = '';
    resetItemForm();
    loadMenu();
  } catch (err) {
    $('#item-msg').textContent = err.message;
  }
});

// ---------------- Mi local ----------------
async function loadStore() {
  await loadProfile();
  const p = state.profile;
  const f = $('#store-form').elements;
  f.name.value = p.name;
  f.addressLabel.value = p.addressLabel;
  f.lat.value = p.location.lat;
  f.lng.value = p.location.lng;
  f.scheduleText.value = p.scheduleText ?? '';
  f.prepMinutes.value = p.prepMinutes;
  for (const k of ['name', 'addressLabel', 'lat', 'lng']) f[k].disabled = !p.editable;
  $('#store-locked').hidden = p.editable;
  $('#docs-list').replaceChildren(...p.documents.map((d) => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
      const fd = new FormData();
      fd.append('file', e.target.files[0]);
      try {
        await api(`/documents/${d.kind}`, { method: 'PUT', form: fd });
        loadStore();
      } catch (err) {
        $('#submit-msg').textContent = err.message;
      }
    } });
    return h('li', {}, `${d.uploaded ? '✅' : '⬜'} ${DOCS[d.kind]} `, input,
      p.editable ? h('button', { class: 'btn small', type: 'button', onclick: () => input.click() }, d.uploaded ? 'Reemplazar' : 'Subir') : null);
  }));
  $('#submit-review').hidden = !p.editable;
}

$('#store-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const out = e.target.querySelector('[data-result]');
  const body = { scheduleText: f.scheduleText.value.trim() || undefined, prepMinutes: Number(f.prepMinutes.value) || undefined };
  if (state.profile.editable) {
    Object.assign(body, { name: f.name.value.trim(), addressLabel: f.addressLabel.value.trim(), lat: Number(f.lat.value), lng: Number(f.lng.value) });
  }
  try {
    await api('/profile', { method: 'PUT', body });
    out.textContent = 'Guardado ✓';
    loadProfile();
  } catch (err) {
    out.textContent = err.message;
  }
});
$('#submit-review').addEventListener('click', async () => {
  try {
    await api('/submit', { method: 'POST' });
    $('#submit-msg').textContent = '';
    loadStore();
  } catch (err) {
    $('#submit-msg').textContent = err.message;
  }
});

// ---------------- Cuenta ----------------
async function loadAccount() {
  const l = await api('/ledger');
  $('#owed').textContent = `Por pagar a UberMarT: ${money(Math.max(0, l.owedCents))}`;
  const label = { commission: 'Comisión pedido', payment: 'Pago recibido', adjustment: 'Ajuste' };
  $('#ledger-body').replaceChildren(...l.entries.map((e) => h('tr', {}, h('td', {}, fmt(e.createdAt)), h('td', {}, label[e.kind] + (e.note ? ` · ${e.note}` : '')), h('td', {}, money(e.amountCents)))));
}

// ---------------- Inicio ----------------
// Con sesión activa se entra directo al panel; si no, al registro (#registro) o al ingreso.
api('/auth/me').then((me) => {
  state.csrf = me.csrfToken;
  return enterApp();
}).catch(() => {
  if (location.hash === '#registro') {
    showView('register');
    regStep(1);
  } else {
    showView('login');
  }
});
