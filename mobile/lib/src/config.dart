import 'package:flutter/foundation.dart';
import 'package:latlong2/latlong.dart';

enum AppMode { passenger, driver }

/// Configuración por compilación:
/// flutter run --flavor driver -t lib/main_driver.dart \
///   --dart-define=API_BASE_URL=https://api.tudominio.ec \
///   --dart-define=TILE_URL=https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=TOKEN
class AppConfig {
  static const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:3000');

  /// Teselas del mapa. OpenStreetMap solo para desarrollo: su política no
  /// permite uso comercial intensivo. En producción usa Mapbox o MapTiler.
  static const tileUrl = String.fromEnvironment(
    'TILE_URL',
    defaultValue: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );

  static const tileAttribution = String.fromEnvironment('TILE_ATTRIBUTION', defaultValue: '© OpenStreetMap');

  static const mantaCenter = LatLng(-0.9536, -80.7286);

  /// En producción solo se permite HTTPS.
  static void assertSecure() {
    if (kReleaseMode && !apiBaseUrl.startsWith('https://')) {
      throw StateError('API_BASE_URL debe usar https en producción');
    }
  }
}
