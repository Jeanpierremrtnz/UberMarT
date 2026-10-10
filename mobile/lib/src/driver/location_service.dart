import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../core/geo.dart';
import '../core/location_throttle.dart';
import '../core/realtime.dart';

/// Envía la ubicación del conductor mientras está en línea.
/// - El sistema solo despierta la app si el teléfono se movió >= 5 m.
/// - [LocationThrottle] decide qué puntos se envían (5-8 s o 15 m).
/// - En Android corre como servicio en primer plano con notificación visible.
class DriverLocationService {
  DriverLocationService(this.realtime);

  final Realtime realtime;
  final throttle = LocationThrottle();
  final current = ValueNotifier<LatLng?>(null);
  StreamSubscription<Position>? _sub;

  bool get running => _sub != null;

  Future<String?> start() async {
    if (_sub != null) return null;
    if (!await Geolocator.isLocationServiceEnabled()) return 'Activa el GPS del teléfono';
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      return 'Necesitamos permiso de ubicación para asignarte viajes';
    }
    final LocationSettings settings;
    if (defaultTargetPlatform == TargetPlatform.android) {
      settings = AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 5,
        intervalDuration: const Duration(seconds: 3),
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: 'UberMarT Conductor',
          notificationText: 'Estás en línea: compartiendo tu ubicación para recibir viajes',
          enableWakeLock: true,
        ),
      );
    } else if (defaultTargetPlatform == TargetPlatform.iOS) {
      settings = AppleSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 5,
        activityType: ActivityType.automotiveNavigation,
        pauseLocationUpdatesAutomatically: false,
        showBackgroundLocationIndicator: true,
        allowBackgroundLocationUpdates: true,
      );
    } else {
      settings = const LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 5);
    }
    throttle.reset();
    _sub = Geolocator.getPositionStream(locationSettings: settings).listen(_onPosition, onError: (_) {});
    return null;
  }

  void _onPosition(Position p) {
    final point = LatLng(p.latitude, p.longitude);
    current.value = point;
    if (!throttle.shouldSend(point, DateTime.now())) return;
    final heading = p.heading.isFinite && p.heading >= 0 ? p.heading.round() % 360 : 0;
    final speedKmh = p.speed.isFinite && p.speed > 0 ? (p.speed * 3.6).round().clamp(0, 250) : 0;
    realtime.sendLocation([toE5(p.latitude), toE5(p.longitude), heading, speedKmh, p.isMocked ? 1 : 0]);
  }

  /// Envía el próximo punto sin esperar (al aceptar un viaje o reconectar).
  void sendNextImmediately() => throttle.reset();

  Future<void> stop() async {
    await _sub?.cancel();
    _sub = null;
  }
}
