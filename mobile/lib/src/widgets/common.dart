import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';
import '../core/services.dart';

TileLayer baseTiles() => TileLayer(urlTemplate: AppConfig.tileUrl, userAgentPackageName: 'ec.ubermart.app');

Marker pin(LatLng point, IconData icon, Color color, {double size = 40}) => Marker(
      point: point,
      width: size,
      height: size,
      alignment: Alignment.topCenter,
      child: Icon(icon, color: color, size: size),
    );

/// Pide permiso y devuelve la ubicación actual, o null si no se concede o el
/// GPS no responde a tiempo (la pantalla sigue con la ubicación por defecto).
Future<Position?> currentPosition({Duration timeout = const Duration(seconds: 8)}) async {
  try {
    if (!await Geolocator.isLocationServiceEnabled().timeout(timeout)) return null;
    var permission = await Geolocator.checkPermission().timeout(timeout);
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) return null;
    return await Geolocator.getCurrentPosition(
      locationSettings: LocationSettings(accuracy: LocationAccuracy.high, timeLimit: timeout),
    ).timeout(timeout + const Duration(seconds: 2));
  } catch (_) {
    return null;
  }
}

/// BOTÓN DE PÁNICO: confirma, envía la alerta con la ubicación y ofrece llamar al 911.
class SosButton extends StatelessWidget {
  const SosButton({super.key, this.tripId});

  final String? tripId;

  Future<void> _trigger(BuildContext context) async {
    final services = Services.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('¿Activar alerta de emergencia?'),
        content: const Text('Avisaremos a la central de UberMarT y a tus contactos de emergencia con tu ubicación.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancelar')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () => Navigator.pop(c, true),
            child: const Text('Enviar alerta'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    Position? position;
    try {
      position = await currentPosition().timeout(const Duration(seconds: 6));
    } catch (_) {
      position = null;
    }
    try {
      await services.api.post('/api/safety/sos', {
        if (tripId != null) 'tripId': tripId,
        if (position != null) 'lat': position.latitude,
        if (position != null) 'lng': position.longitude,
      });
      if (!context.mounted) return;
      showMessage(context, 'Alerta enviada. Si estás en peligro llama al 911.');
    } catch (e) {
      if (context.mounted) showMessage(context, 'No se pudo enviar la alerta: $e. Llama al 911.');
    }
    await launchUrl(Uri.parse('tel:911'));
  }

  /// Se muestra en la barra superior para que siempre esté visible sin tapar controles.
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: FilledButton(
        style: FilledButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
        onPressed: () => _trigger(context),
        child: const Text('SOS', style: TextStyle(fontWeight: FontWeight.bold, letterSpacing: 1.5)),
      ),
    );
  }
}
