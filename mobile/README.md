# UberMarT — apps móviles (Flutter)

Un solo código para dos apps:

| App | Flavor Android | Application ID | Punto de entrada |
|-----|----------------|----------------|------------------|
| Pasajero | `passenger` | `ec.ubermart.app` | `lib/main_passenger.dart` |
| Conductor | `driver` | `ec.ubermart.driver` | `lib/main_driver.dart` |

```bash
flutter pub get
flutter run --flavor passenger -t lib/main_passenger.dart --dart-define=API_BASE_URL=http://10.0.2.2:3000
flutter run --flavor driver -t lib/main_driver.dart --dart-define=API_BASE_URL=http://10.0.2.2:3000
flutter analyze && flutter test
```

`--dart-define` disponibles: `API_BASE_URL` (https obligatorio en release), `TILE_URL`,
`TILE_ATTRIBUTION`. Compilación de producción: ver `../docs/DESPLIEGUE.md`.

## Estructura

```
lib/src/
  core/        cliente HTTP con renovación de token, sesión segura, WebSocket,
               frecuencia inteligente de GPS, validaciones
  auth/        ingreso por SMS y registro de identidad
  passenger/   mapa, cotización con desglose, viaje en vivo (PIN, compartir, SOS)
  driver/      registro KYC, billetera y recargas, ofertas, viaje y GPS
  shared/      contactos de emergencia
  widgets/     mapa base y botón SOS
```
