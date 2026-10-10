import { z } from 'zod';

const lat = z.number().finite().min(-90).max(90);
const lng = z.number().finite().min(-180).max(180);
const point = z.object({ lat, lng });
const label = z.string().trim().max(160).optional();
export const uuid = z.uuid();
const deviceId = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/, 'deviceId inválido');

export const S = {
  otpRequest: z.object({ phone: z.string().max(20) }),
  otpVerify: z.object({ challengeId: uuid, code: z.string().regex(/^[0-9]{6}$/), deviceId }),
  refresh: z.object({ refreshToken: z.string().min(20).max(100), deviceId }),
  logout: z.object({ refreshToken: z.string().min(20).max(100) }),
  profile: z.object({
    fullName: z.string().trim().min(3).max(120).regex(/^[\p{L}][\p{L} .'-]+$/u, 'Nombre inválido'),
    cedula: z.string().regex(/^[0-9]{10}$/, 'La cédula tiene 10 dígitos'),
    email: z.email().max(254).optional(),
  }),
  contact: z.object({ name: z.string().trim().min(2).max(80), phone: z.string().max(20) }),

  driverApplication: z.object({
    licenseNumber: z.string().trim().regex(/^[A-Za-z0-9-]{6,20}$/, 'Número de licencia inválido'),
    licenseExpiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD'),
    plate: z.string().max(10),
    motoBrand: z.string().trim().min(2).max(40),
    motoModel: z.string().trim().min(1).max(40),
    motoYear: z.number().int().min(1990).max(new Date().getFullYear() + 1),
    motoColor: z.string().trim().min(2).max(30),
  }),
  online: z.object({ online: z.boolean() }),

  transferTopup: z.object({
    bank: z.string().max(20),
    reference: z.string().trim().min(1).max(60),
    amountCents: z.coerce.number().int().positive(),
  }),
  resubmitTopup: z.object({ amountCents: z.coerce.number().int().positive().optional() }),
  gatewayTopup: z.object({ amountCents: z.number().int().positive() }),

  quote: z.object({
    service: z.enum(['ride', 'parcel']).default('ride'),
    origin: point,
    destination: point,
    originLabel: label,
    destinationLabel: label,
    parcel: z.object({
      recipientName: z.string().trim().min(2).max(80),
      recipientPhone: z.string().max(20),
      description: z.string().trim().min(3).max(200),
      size: z.enum(['sobre', 'pequeno', 'mediano']),
      weightKg: z.number().positive().max(30),
      declaredValueCents: z.number().int().min(0).max(100_000).default(0),
      payer: z.enum(['sender', 'recipient']),
      prohibitedItemsAck: z.literal(true, { message: 'Debes confirmar que el envío no contiene artículos prohibidos' }),
    }).optional(),
  }),
  tripRequest: z.object({ quoteId: uuid }),
  pin: z.object({ pin: z.string().regex(/^[0-9]{4}$/).optional() }),
  deliveryPin: z.object({ pin: z.string().regex(/^[0-9]{4}$/).optional() }),

  // Delivery de comida
  orderQuote: z.object({
    merchantId: uuid,
    items: z.array(z.object({
      itemId: uuid,
      qty: z.number().int().min(1).max(20),
      note: z.string().trim().max(120).optional(),
    })).min(1).max(30),
    destination: point,
    destinationLabel: z.string().trim().min(3).max(160),
  }),
  orderPlace: z.object({ quoteId: uuid, note: z.string().trim().max(300).optional() }),
  nearby: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }),

  // Registro y panel de locales
  merchantOtp: z.object({ phone: z.string().max(20) }),
  merchantRegister: z.object({
    challengeId: uuid,
    code: z.string().regex(/^[0-9]{6}$/),
    business: z.object({
      name: z.string().trim().min(2).max(80),
      category: z.enum(['restaurante', 'cafeteria', 'comida_rapida', 'panaderia', 'farmacia', 'tienda', 'otro']),
      ruc: z.string().regex(/^[0-9]{13}$/, 'El RUC tiene 13 dígitos'),
      addressLabel: z.string().trim().min(5).max(160),
      lat,
      lng,
      scheduleText: z.string().trim().max(120).optional(),
    }),
    owner: z.object({
      fullName: z.string().trim().min(3).max(120).regex(/^[\p{L}][\p{L} .'-]+$/u, 'Nombre inválido'),
      cedula: z.string().regex(/^[0-9]{10}$/, 'La cédula tiene 10 dígitos'),
      email: z.email().max(254),
      password: z.string().min(12).max(128),
    }),
  }),
  merchantProfile: z.object({
    name: z.string().trim().min(2).max(80).optional(),
    category: z.enum(['restaurante', 'cafeteria', 'comida_rapida', 'panaderia', 'farmacia', 'tienda', 'otro']).optional(),
    addressLabel: z.string().trim().min(5).max(160).optional(),
    lat: lat.optional(),
    lng: lng.optional(),
    scheduleText: z.string().trim().max(120).optional(),
    prepMinutes: z.number().int().min(1).max(120).optional(),
  }),
  merchantStore: z.object({ isOpen: z.boolean() }),
  menuItem: z.object({
    category: z.string().trim().min(1).max(40).default('General'),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).optional(),
    priceCents: z.number().int().min(1).max(100_000),
    isAvailable: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(0),
  }),
  menuItemPatch: z.object({
    category: z.string().trim().min(1).max(40).optional(),
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(300).optional(),
    priceCents: z.number().int().min(1).max(100_000).optional(),
    isAvailable: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  }),
  orderAccept: z.object({ prepMinutes: z.number().int().min(1).max(120) }),
  orderReject: z.object({ reason: z.enum(['sin_stock', 'cerrando', 'demasiados_pedidos', 'direccion_fuera_de_zona', 'otro']) }),
  merchantReview: z.object({ note: z.string().trim().max(300).optional(), commissionBps: z.number().int().min(0).max(5000).optional() }),
  merchantPayment: z.object({ amountCents: z.number().int().min(1).max(10_000_000), note: z.string().trim().max(300).optional() }),
  cancel: z.object({ reason: z.string().trim().max(200).optional() }),
  rate: z.object({ stars: z.number().int().min(1).max(5) }),
  sos: z.object({ tripId: uuid.optional(), lat: lat.optional(), lng: lng.optional(), message: z.string().trim().max(500).optional() }),

  adminLogin: z.object({
    email: z.email().max(254),
    password: z.string().min(1).max(128),
    totp: z.string().regex(/^[0-9]{6}$/),
  }),
  topupReject: z.object({
    reason: z.enum(['duplicado', 'ilegible', 'monto_incorrecto', 'referencia_incorrecta', 'no_acreditado', 'fraude']),
    note: z.string().trim().max(300).optional(),
  }),
  bankStatement: z.object({
    csv: z.string().min(10).max(2_000_000),
    referenceColumn: z.string().max(60).optional(),
    amountColumn: z.string().max(60).optional(),
    dateColumn: z.string().max(60).optional(),
  }),
  reviewNote: z.object({ note: z.string().trim().max(300).optional() }),
  suspendUser: z.object({ reason: z.string().trim().min(3).max(300) }),
  zone: z.object({
    slug: z.string().regex(/^[a-z0-9-]{2,40}$/),
    name: z.string().trim().min(2).max(80),
    area: z.object({
      type: z.literal('Polygon'),
      coordinates: z.array(z.array(z.tuple([lng, lat])).min(4).max(500)).length(1),
    }),
    surgeEnabled: z.boolean().default(true),
    maxMultiplier: z.number().min(1).max(3).default(1.5),
    isActive: z.boolean().default(true),
  }),
  timeRule: z.object({
    name: z.string().trim().min(2).max(80),
    isoDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    startLocal: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    endLocal: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    multiplier: z.number().min(1).max(3),
    isActive: z.boolean().default(true),
  }),
  geoSearch: z.object({ q: z.string().trim().min(3).max(120) }),
  geoReverse: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }),
};
