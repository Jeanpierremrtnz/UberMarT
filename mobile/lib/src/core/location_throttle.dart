import 'package:latlong2/latlong.dart';

import 'geo.dart';

/// Frecuencia inteligente de envío de GPS del conductor:
///  - envía si se movió más de [distanceTriggerM] (15 m), o
///  - envía cada [timeTrigger] (6 s, dentro del rango 5-8 s) SOLO si hubo
///    movimiento real (> [jitterM], para ignorar el "temblor" del GPS),
///  - nunca más seguido que [minInterval] (protege batería y datos),
///  - si la moto está detenida (semáforo en la Av. 4 de Noviembre) NO envía
///    datos repetidos.
class LocationThrottle {
  LocationThrottle({
    this.distanceTriggerM = 15,
    this.timeTrigger = const Duration(seconds: 6),
    this.minInterval = const Duration(seconds: 3),
    this.jitterM = 4,
  });

  final double distanceTriggerM;
  final Duration timeTrigger;
  final Duration minInterval;
  final double jitterM;

  LatLng? _lastSent;
  DateTime? _lastSentAt;

  bool shouldSend(LatLng point, DateTime now) {
    final last = _lastSent;
    final lastAt = _lastSentAt;
    if (last == null || lastAt == null) return _accept(point, now);
    final elapsed = now.difference(lastAt);
    if (elapsed < minInterval) return false;
    final moved = haversineMeters(last, point);
    if (moved >= distanceTriggerM) return _accept(point, now);
    if (elapsed >= timeTrigger && moved > jitterM) return _accept(point, now);
    return false;
  }

  /// Fuerza el siguiente envío (p. ej. al aceptar un viaje o reconectar).
  void reset() {
    _lastSent = null;
    _lastSentAt = null;
  }

  bool _accept(LatLng point, DateTime now) {
    _lastSent = point;
    _lastSentAt = now;
    return true;
  }
}
