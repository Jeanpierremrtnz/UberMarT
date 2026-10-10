# Arquitectura y decisiones técnicas

## Vista general

```
 App cliente (Flutter)         App conductor (Flutter)     Panel admin y panel /comercio (web)
        │  HTTPS (REST)  ▲ WebSocket      │ HTTPS ▲ WebSocket        │ HTTPS + cookie
        │                │ eventos        │       │ GPS + ofertas    │ SSE (alertas)
        ▼                │                ▼       │                  ▼
 ┌───────────────────────────── Caddy (TLS automático, HSTS, filtro IP del panel) ─────┐
 │                                   API Node.js 22                                     │
 │  Express (REST)  ·  Socket.io (/ws, solo websocket)  ·  Despachador  ·  Tarifas      │
 └──────┬──────────────────────┬──────────────────────┬───────────────────┬────────────┘
        │ SQL (rol mínimo)     │ HTTP interno         │ HTTPS             │ HTTPS
        ▼                      ▼                      ▼                   ▼
  PostgreSQL 16 + PostGIS   OSRM (rutas, propio)   Payphone / Twilio   OpenWeather
  + archivos cifrados (KYC y comprobantes, AES-256-GCM en disco)
```

Todo corre en un solo servidor con Docker Compose (DigitalOcean de 2-4 GB). Solo
Caddy expone puertos; la base de datos y OSRM viven en una red interna sin salida.

## Servicios

Los tres servicios comparten el mismo motor (cotización, despacho por cercanía, GPS
en vivo, SOS, comisión del conductor). Cada viaje tiene un `service`:

| Servicio | Recogida | Entrega | Cobro en efectivo |
|----------|----------|---------|-------------------|
| `ride` (viaje) | PIN del pasajero | — | Al llegar |
| `parcel` (mensajería) | Foto + PIN del remitente | Foto + PIN del destinatario (SMS) | Al recoger o al entregar, según quién paga |
| `food` (delivery) | El local marca "listo"; el motorizado le paga la comida | PIN del cliente | Total (comida + envío) al entregar |

Delivery agrega locales (`merchants`), productos (`menu_items`), pedidos (`orders`) y la
cuenta de comisiones de cada local (`merchant_ledger`, solo-anexar). El pedido nace de
una cotización que congela el carrito con precios de la base de datos.

## Componentes

### Backend (`backend/`)
- **Express 5** para la API REST. Toda entrada se valida con **zod**; todo SQL es parametrizado.
- **Socket.io** en `/ws`, únicamente transporte WebSocket (sin long-polling). Se usa
  para *empujar* datos (ubicación, ofertas, cambios de estado). Las transiciones de
  estado (aceptar, iniciar, finalizar) van por REST: son confiables, idempotentes y auditables.
- **PostgreSQL + PostGIS**: búsqueda del conductor más cercano con índice GiST y
  operador KNN `<->`, geocercas con `ST_Contains`, distancias con `ST_DWithin`.
- **Despachador**: al pedir un viaje se notifica a las 5 motos más cercanas (2,5 km);
  si nadie acepta en 20 s se amplía a 4 km y luego a 6 km; después expira. El primer
  conductor que acepta gana (actualización atómica `WHERE status = 'searching'`) y un
  índice único impide que un conductor tenga dos viajes activos.
- **Precio fijo por adelantado**: la cotización se guarda en el servidor (5 min) y el
  viaje se crea a partir de ella. El cliente nunca envía el precio.

### Paneles web (`admin/` y `comercio/`)
HTML + JavaScript sin dependencias ni CDN (Content-Security-Policy `'self'`). Las
alertas y los pedidos en vivo llegan por Server-Sent Events (nativo del navegador).
El panel interno puede restringirse por IP; el de comercios es público para los locales.

### Apps móviles (`mobile/`)
Un solo proyecto Flutter con dos puntos de entrada y dos *flavors* de Android
(`ec.ubermart.app` y `ec.ubermart.driver`), así se publican como dos apps sin duplicar código.
- Mapas: `flutter_map` (equivalente a Leaflet) con teselas de Mapbox/MapTiler configurables.
- Rutas y tiempos: OSRM propio (el servidor devuelve la polilínea).
- Navegación del conductor: abre Google Maps/Waze, que el motorizado ya domina.

## Protocolo de ubicación en tiempo real

Paquete del conductor (evento `loc`), JSON de ~30 bytes:

```
[latE5, lngE5, rumbo, velocidadKmH, gpsSimulado]   ej. [-95021, -8073120, 182, 34, 0]
```

- `E5` = coordenada × 100 000 (precisión ~1,1 m) como entero.
- La app envía si se movió > 15 m, o cada 6 s si hubo movimiento real (> 4 m), nunca
  más seguido que cada 3 s. Detenido en un semáforo: no envía nada. El sistema
  operativo solo despierta la app cuando el teléfono se movió ≥ 5 m (ahorro de batería).
- Consumo estimado: ~400 KB de datos por jornada de 8 horas.
- El servidor vuelve a filtrar: descarta envíos < 2 s, saltos imposibles (> 140 km/h)
  y puntos con la marca de GPS simulado, y registra la anomalía para revisión.
- El pasajero recibe `dloc` = `[latE5, lngE5, rumbo]` solo durante su viaje
  (sala `trip:<id>`, con autorización). Los mensajes de ubicación son *volatile*: si el
  teléfono estuvo sin señal no recibe ubicaciones viejas en ráfaga.
- Los pasajeros nunca ven la ubicación de motos que no les fueron asignadas (solo
  cuántas hay cerca y el tiempo estimado), para no exponer a los conductores a robos.

## Tarifas

`Tarifa = max(Mínima, (Base + CostoKm × Km + CostoMin × Min) × Multiplicador) + RecargoLluvia`

- **Multiplicador** = el mayor entre zona caliente y regla horaria (no se multiplican
  entre sí: 1,5 × 1,2 = 1,8 sería abusivo e impredecible), con tope global de 2×.
- **Zona caliente**: por cada geocerca, demanda = pasajeros distintos que cotizaron en
  los últimos 10 min; oferta = motos libres dentro de la zona. Con demanda ≥ 4:
  ratio ≥ 2 → 1,2×; ratio ≥ 4 → 1,5× (configurable). 20 solicitudes / 3 motos → 1,5×.
- **Hora pico**: L-V 07:15-08:15 → 1,2× (reglas editables, en hora de Ecuador UTC-5).
- **Lluvia**: códigos de OpenWeather de lluvia moderada/fuerte o tormenta, o ≥ 2,5 mm/h →
  +$0,50 fijo, visible en el desglose. Interruptor manual en el panel.
- Redondeo a $0,05 (pago en efectivo). Valores iniciales: base $0,40; km $0,25;
  minuto $0,05; mínima $1,00 — ajustables en el panel sin redesplegar.

## Decisiones respecto al plan original

| Plan | Decisión | Motivo |
|------|----------|--------|
| Mapbox SDK | `flutter_map` + teselas Mapbox/MapTiler | Mismo resultado visual, sin SDK nativo pesado ni costos por usuario activo |
| Multiplicadores acumulables | Se aplica el mayor, con tope | Precio predecible y justo; evita abusos |
| Revisión manual de capturas | Referencia única + imagen única + panel + conciliación bancaria | Las capturas se pueden falsificar; el estado de cuenta es la prueba real |
| Webhook de Payphone como verdad | El webhook solo dispara una confirmación servidor-a-servidor | Un webhook falsificado no puede acreditar saldo |
| Panel con WebSockets | Server-Sent Events | Nativo del navegador, sin bibliotecas externas en el panel |
| Perfil OSRM de moto | Perfil `car` + factor de tiempo configurable | OSRM no trae perfil de moto; las motos usan las mismas vías |

## Escalar

- Hasta ~100-200 conductores simultáneos: 1 servidor de 2-4 GB (estado actual).
- Más instancias de la API: agregar Redis (adaptador de Socket.io y límites de
  solicitudes compartidos) y mover los archivos a DigitalOcean Spaces/S3.
- Portoviejo o Chone: crear sus geocercas en el panel; OSRM ya cubre Manabí.
