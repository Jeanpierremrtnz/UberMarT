# Referencia de la API

Base: `https://api.tudominio.ec`. JSON en UTF-8. Dinero en **centavos** (enteros).
Errores: `{ "error": { "code": "REFERENCE_ALREADY_USED", "message": "…", "details"?: … } }`.
Apps: `Authorization: Bearer <accessToken>`. Panel: cookie de sesión + `X-CSRF-Token`.

## Autenticación (apps)
| Método | Ruta | Cuerpo | Notas |
|---|---|---|---|
| POST | `/api/auth/otp/request` | `{ phone }` | Envía SMS. → `{ challengeId, expiresInSec }` |
| POST | `/api/auth/otp/verify` | `{ challengeId, code, deviceId }` | → `{ accessToken, refreshToken, expiresIn, user }` |
| POST | `/api/auth/refresh` | `{ refreshToken, deviceId }` | Rota el token |
| POST | `/api/auth/logout` | `{ refreshToken }` | Revoca la sesión |

## Perfil
| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/me` | Perfil (cédula enmascarada) |
| PUT | `/api/me/profile` | `{ fullName, cedula, email? }` — obligatorio antes de pedir viajes |
| GET/POST | `/api/me/emergency-contacts` | `{ name, phone }` (máx. 3) |
| DELETE | `/api/me/emergency-contacts/:id` | |

## Conductor
| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/driver/application` | Estado del registro y documentos |
| PUT | `/api/driver/application` | `{ licenseNumber, licenseExpiresOn, plate, motoBrand, motoModel, motoYear, motoColor }` |
| PUT | `/api/driver/documents/:kind` | multipart `file`. `kind`: cedula_front, cedula_back, license_front, license_back, vehicle_registration, criminal_record, selfie, moto_photo |
| POST | `/api/driver/application/submit` | Envía a revisión |
| POST | `/api/driver/online` | `{ online: true|false }` (requiere aprobado, licencia vigente y saldo mínimo) |

## Billetera y recargas (conductor aprobado)
| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/wallet` | Saldo, últimos movimientos, cuentas para transferir, límites |
| GET | `/api/wallet/topups` | Historial de recargas |
| GET | `/api/wallet/topups/check-reference?reference=` | `{ available }` (verificación instantánea) |
| POST | `/api/wallet/topups` | multipart: `bank`, `reference`, `amountCents`, `receipt` (imagen) |
| POST | `/api/wallet/topups/:id/resubmit` | multipart: `receipt?`, `amountCents?` |
| POST | `/api/wallet/topups/payphone` | `{ amountCents }` → `{ topupId, payWithCardUrl, payWithPayphoneUrl }` |

## Viajes
| Método | Ruta | Quién | Notas |
|---|---|---|---|
| POST | `/api/trips/quote` | pasajero | `{ origin:{lat,lng}, destination:{lat,lng}, originLabel?, destinationLabel? }` → total, desglose, polilínea, motos cerca |
| POST | `/api/trips` | pasajero | `{ quoteId }` → viaje con `pin` |
| GET | `/api/trips/current`, `/api/trips/history`, `/api/trips/:id` | ambos | |
| POST | `/api/trips/:id/accept` · `/decline` | conductor | |
| POST | `/api/trips/:id/arrived` | conductor | Debe estar a ≤ 300 m |
| POST | `/api/trips/:id/start` | conductor | `{ pin }` |
| POST | `/api/trips/:id/complete` | conductor | Descuenta la comisión |
| POST | `/api/trips/:id/cancel` | ambos | `{ reason? }`. Si cancela el conductor, se reasigna |
| POST | `/api/trips/:id/rate` | ambos | `{ stars: 1-5 }` |
| POST | `/api/trips/:id/share` | ambos | → `{ url }` de seguimiento |
| POST | `/api/safety/sos` | ambos | `{ tripId?, lat?, lng?, message? }` |
| GET | `/api/geo/search?q=` · `/api/geo/reverse?lat=&lng=` | ambos | Requiere `GEOCODER_URL` |

## Mensajería
`POST /api/trips/quote` con `service: "parcel"` y
`parcel: { recipientName, recipientPhone, description, size: sobre|pequeno|mediano, weightKg, declaredValueCents, payer: sender|recipient, prohibitedItemsAck: true }`.
Luego `POST /api/trips { quoteId }`. El conductor usa:
| Método | Ruta | Notas |
|---|---|---|
| PUT | `/api/trips/:id/photos/pickup` · `/dropoff` | multipart `file` (obligatoria en mensajería) |
| GET | `/api/trips/:id/photos/:stage` | Cliente y conductor del servicio |
| POST | `/api/trips/:id/start` | `{ pin }` del remitente (en comida: sin PIN, el local debe marcar "listo") |
| POST | `/api/trips/:id/complete` | `{ pin }` de entrega (mensajería y comida) |
| GET | `/api/trips/active` | Todos los servicios activos del cliente |

## Delivery de comida (cliente)
| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/merchants?lat=&lng=` | Locales aprobados cercanos |
| GET | `/api/merchants/:id` | Datos y productos disponibles |
| GET | `/api/merchants/:id/items/:itemId/photo` | Foto pública del producto |
| POST | `/api/orders/quote` | `{ merchantId, items:[{itemId, qty, note?}], destination:{lat,lng}, destinationLabel }` |
| POST | `/api/orders` | `{ quoteId, note? }` |
| GET | `/api/orders` · `/api/orders/:id` | Incluye `deliveryPin` y motorizado asignado |
| POST | `/api/orders/:id/cancel` | Solo antes de que el local acepte |

## Panel de comercios (`/api/merchant`, cookie + `X-CSRF-Token`)
`POST /register/otp {phone}` · `POST /register {challengeId, code, business, owner}` → `{ merchantId, totpSecret, totpUri }`
· `POST /auth/login {email,password,totp}` · `POST /auth/logout` · `GET /auth/me` · `GET /events` (SSE: `order:new`, `order:update`, `merchant:status`)
· `GET|PUT /profile` · `PUT /documents/:kind` (ruc, permiso_funcionamiento, cedula_owner, storefront) · `POST /submit` · `PUT /store {isOpen}`
· `GET|POST /menu` · `PUT|DELETE /menu/:id` · `PUT|GET /menu/:id/photo`
· `GET /orders?scope=active|history` · `POST /orders/:id/accept {prepMinutes}` · `POST /orders/:id/reject {reason}` · `POST /orders/:id/ready`
· `GET /ledger`

## Públicas
| Método | Ruta | Notas |
|---|---|---|
| GET | `/healthz` | Estado |
| GET | `/s/:token` | Página de seguimiento compartido |
| GET | `/api/payments/payphone/return` | Retorno de Payphone (confirma y acredita) |
| POST | `/api/payments/payphone/notify/:secret` | Notificación de Payphone |

## Panel (`/api/admin`)
`POST /auth/login {email,password,totp}` · `POST /auth/logout` · `GET /auth/me` · `GET /events` (SSE)
· `GET /topups/queue` · `GET /topups/:id/receipt` · `POST /topups/:id/approve` · `POST /topups/:id/reject {reason,note?}`
· `POST /bank-statements {csv}` · `GET /wallets/integrity`
· `GET /drivers?status=` · `GET /drivers/:id` · `GET /drivers/:id/documents/:kind` · `POST /drivers/:id/{approve|reject|suspend} {note?}`
· `POST /users/:id/suspend {reason}` · `POST /users/:id/reactivate`
· `GET /incidents?status=` · `POST /incidents/:id/{acknowledge|resolve}`
· `GET|PUT /settings/{pricing|surge|wallet|dispatch|weather|topupAccounts}` · `GET /pricing/snapshot`
· `POST /zones` · `PUT /zones/:id {slug,name,area(GeoJSON Polygon),surgeEnabled,maxMultiplier,isActive}`
· `GET /time-rules` · `POST /time-rules` · `PUT /time-rules/:id {name,isoDays,startLocal,endLocal,multiplier,isActive}`
· `GET /merchants?status=` · `GET /merchants/:id` · `GET /merchants/:id/documents/:kind` · `POST /merchants/:id/{approve|reject|suspend} {note?, commissionBps?}`
· `POST /merchants/:id/payments {amountCents, note?}` · `GET|PUT /settings/services` (tarifas y reglas de mensajería y delivery)

## Tiempo real (Socket.io)
Conexión: `path: "/ws"`, `transports: ["websocket"]`, `auth: { token: <accessToken> }`.
La conexión se cierra al vencer el token; reconectar con uno nuevo.

| Dirección | Evento | Datos |
|---|---|---|
| conductor → servidor | `loc` | `[latE5, lngE5, rumbo, kmh, gpsSimulado]` |
| cliente → servidor | `trip:watch` (con ack) | `{ tripId }` → `{ ok }` |
| servidor → conductor | `trip:offer` | `{ tripId, service, pickup, dropoff, fareCents, collectCents, collectAt, parcel?, food?, tripDistanceM, pickupDistanceM, expiresInSec }` |
| servidor → conductor | `trip:offer_closed` | `{ tripId }` |
| servidor → pasajero | `trip:searching` | `{ tripId, round, driversNotified }` |
| servidor → ambos | `trip:update` | Viaje completo según el rol |
| servidor → sala del viaje | `dloc` | `[latE5, lngE5, rumbo]` |
| servidor → conductor | `wallet:update` · `topup:update` · `driver:status` | |
| servidor → cliente | `order:update` | Pedido de comida actualizado |

Panel (SSE `/api/admin/events`): `sos`, `topup:new`, `driver:submitted`, `merchant:registered`, `merchant:submitted`, `order:no_driver`, `payment:mismatch`.
