# UberMarT

Plataforma de servicios en moto para Manta (Ecuador): **viajes**, **mensajería
(encomiendas)** y **delivery de comida**. Incluye la app del cliente, la app del
conductor, el panel web para restaurantes y locales, la API en tiempo real y el
panel administrativo. Diseñada con la seguridad de conductores, clientes y
comercios como prioridad.

## Estructura

| Carpeta    | Contenido |
|------------|-----------|
| `backend/` | API Node.js + Express, tiempo real con Socket.io, PostgreSQL + PostGIS |
| `admin/`   | Panel web interno (recargas, conductores, comercios, SOS, tarifas) |
| `comercio/`| Panel web para restaurantes y locales (registro, productos, pedidos) |
| `public/`  | Estilos e íconos compartidos de las páginas web |
| `mobile/`  | Apps Flutter (cliente y conductor desde un mismo código) |
| `infra/`   | Docker Compose, Caddy (HTTPS), OSRM, roles de BD y respaldos |
| `docs/`    | Arquitectura, seguridad, operación, despliegue y API |

## Lo que ya funciona

- **Registro seguro**: ingreso por SMS (OTP), cédula validada (módulo 10), única y cifrada;
  conductores con verificación de documentos (KYC) revisada en el panel.
- **Recargas sin morir en el intento**:
  1. Referencia y monto obligatorios + filtro antiduplicados (referencia e imagen únicas en todo el sistema).
  2. Panel de aprobación rápida: foto a un lado, datos al otro, `A` aprobar / `R` rechazar.
  3. Payphone: link de pago y acreditación automática confirmada servidor-a-servidor.
  4. Extra: conciliación con el estado de cuenta bancario (CSV).
- **GPS en tiempo real** por WebSocket con paquetes de ~30 bytes y frecuencia inteligente
  (5-8 s o 15 m; nada si la moto está detenida), con detección de GPS falso.
- **Tarifas dinámicas**: fórmula transparente, zonas calientes (geocercas PostGIS),
  hora pico (L-V 07:15-08:15) y recargo por lluvia (OpenWeather o manual).
- **Seguridad en el viaje**: PIN de abordaje, botón SOS con SMS a contactos de emergencia,
  link de seguimiento en vivo que expira, recorrido guardado para investigaciones.
- **Mensajería**: datos del paquete y declaración de artículos prohibidos, foto al recoger
  y al entregar, y el destinatario recibe por SMS el seguimiento y un PIN sin el cual no
  se puede marcar como entregado.
- **Delivery de comida**: los restaurantes se registran solos (SMS, RUC, autenticador,
  documentos), cargan productos con foto y reciben pedidos en vivo en `/comercio`. El
  panel interno los aprueba antes de publicarlos. Precios siempre desde el servidor,
  límite de monto por pedido para proteger al motorizado y PIN de entrega del cliente.
- **Billetera del conductor** con libro contable inmutable y comisión automática por viaje.

## Inicio rápido (desarrollo)

Requisitos: Node.js 22, PostgreSQL 16 con PostGIS 3, Flutter 3.x.

```bash
cd backend
npm ci
npm run gen:secrets          # copia APP_MASTER_KEY y JWT_PRIVATE_KEY a .env
cp .env.example .env         # ajusta DATABASE_URL, NODE_ENV=development, COOKIE_SECURE=false,
                             # SMS_PROVIDER=console, PUBLIC_BASE_URL=http://localhost:3000
DATABASE_URL=postgres://... npm run migrate
npm run admin:create -- tu@correo.com "Tu Nombre" owner
npm run dev                  # API en http://localhost:3000, paneles en /admin/ y /comercio/
npm test                     # pruebas unitarias e integración (requiere BD de pruebas)
```

Apps móviles:

```bash
cd mobile
flutter pub get
flutter run --flavor passenger -t lib/main_passenger.dart --dart-define=API_BASE_URL=http://10.0.2.2:3000
flutter run --flavor driver    -t lib/main_driver.dart    --dart-define=API_BASE_URL=http://10.0.2.2:3000
```

Producción: ver [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Documentación

- [Arquitectura y decisiones técnicas](docs/ARQUITECTURA.md)
- [Modelo de seguridad](docs/SEGURIDAD.md)
- [Operación: recargas, conductores, SOS y tarifas](docs/OPERACION.md)
- [Despliegue en servidor](docs/DESPLIEGUE.md)
- [Referencia de la API y eventos en tiempo real](docs/API.md)
- [Hoja de ruta](docs/ROADMAP.md)

## Propiedad

Software propietario. Todos los derechos reservados. Ver [LICENSE](LICENSE).
