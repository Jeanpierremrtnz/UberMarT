import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../widgets/common.dart';
import 'location_service.dart';

/// Viaje del conductor: llegar, validar el PIN del pasajero, iniciar y finalizar.
class DriverTripScreen extends StatefulWidget {
  const DriverTripScreen({super.key, required this.initial, required this.location});

  final Map<String, dynamic> initial;
  final DriverLocationService location;

  @override
  State<DriverTripScreen> createState() => _DriverTripScreenState();
}

class _DriverTripScreenState extends State<DriverTripScreen> {
  late Map<String, dynamic> _trip = widget.initial;
  final _pin = TextEditingController();
  bool _busy = false;
  Map<String, dynamic>? _summary;

  String get _id => _trip['id'] as String;
  String get _status => _trip['status'] as String;

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _action(String path, [Map<String, dynamic>? body]) async {
    setState(() => _busy = true);
    try {
      final res = Map<String, dynamic>.from(await Services.of(context).api.post('/api/trips/$_id/$path', body) as Map);
      setState(() {
        _trip = res;
        if (path == 'complete') _summary = res;
      });
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _cancel() async {
    final reason = await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(title: const Text('Motivo de cancelación'), children: [
        for (final r in ['El pasajero no llegó', 'Problema con la moto', 'Dirección peligrosa', 'Otro'])
          SimpleDialogOption(onPressed: () => Navigator.pop(c, r), child: Text(r)),
      ]),
    );
    if (reason == null || !mounted) return;
    try {
      await Services.of(context).api.post('/api/trips/$_id/cancel', {'reason': reason});
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  /// Navegación paso a paso con la app que el conductor ya usa (Google Maps / Waze).
  Future<void> _navigate(LatLng to) => launchUrl(
        Uri.parse('https://www.google.com/maps/dir/?api=1&destination=${to.latitude},${to.longitude}&travelmode=two-wheeler'),
        mode: LaunchMode.externalApplication,
      );

  @override
  Widget build(BuildContext context) {
    final origin = _trip['origin'] as Map;
    final dest = _trip['destination'] as Map;
    final pickup = LatLng((origin['lat'] as num).toDouble(), (origin['lng'] as num).toDouble());
    final dropoff = LatLng((dest['lat'] as num).toDouble(), (dest['lng'] as num).toDouble());
    final passenger = _trip['passenger'] as Map?;
    final target = _status == 'in_progress' ? dropoff : pickup;

    return Scaffold(
      appBar: AppBar(title: Text(passenger?['firstName'] != null ? 'Pasajero: ${passenger!['firstName']}' : 'Viaje')),
      floatingActionButton: _status == 'completed' || _status == 'cancelled' ? null : SosButton(tripId: _id),
      floatingActionButtonLocation: FloatingActionButtonLocation.endTop,
      body: Column(children: [
        Expanded(
          child: ValueListenableBuilder<LatLng?>(
            valueListenable: widget.location.current,
            builder: (context, here, _) => FlutterMap(
              options: MapOptions(initialCenter: here ?? pickup, initialZoom: 15),
              children: [
                baseTiles(),
                MarkerLayer(markers: [
                  pin(pickup, Icons.trip_origin, Colors.green),
                  pin(dropoff, Icons.location_on, Colors.red),
                  if (here != null) pin(here, Icons.two_wheeler, Colors.black, size: 36),
                ]),
                const RichAttributionWidget(attributions: [TextSourceAttribution(AppConfig.tileAttribution)]),
              ],
            ),
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: _controls(target)),
          ),
        ),
      ]),
    );
  }

  List<Widget> _controls(LatLng target) {
    final fare = formatCents(_trip['fareCents'] as int);
    switch (_status) {
      case 'accepted':
        return [
          Text('Ve a recoger al pasajero · Tarifa $fare', textAlign: TextAlign.center),
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: () => _navigate(target), icon: const Icon(Icons.navigation), label: const Text('Navegar')),
          FilledButton(onPressed: _busy ? null : () => _action('arrived'), child: const Text('Llegué al punto de recogida')),
          TextButton(onPressed: _cancel, child: const Text('Cancelar viaje')),
        ];
      case 'arrived':
        return [
          const Text('Pide al pasajero el PIN de 4 dígitos que aparece en su app.', textAlign: TextAlign.center),
          const SizedBox(height: 8),
          TextField(
            controller: _pin,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 28, letterSpacing: 8),
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
            decoration: const InputDecoration(labelText: 'PIN del pasajero'),
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _busy ? null : () => _action('start', {'pin': _pin.text}),
            child: const Text('Iniciar viaje'),
          ),
          TextButton(onPressed: _cancel, child: const Text('Cancelar viaje')),
        ];
      case 'in_progress':
        return [
          Text('Rumbo al destino · Cobra $fare en efectivo', textAlign: TextAlign.center),
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: () => _navigate(target), icon: const Icon(Icons.navigation), label: const Text('Navegar')),
          FilledButton(onPressed: _busy ? null : () => _action('complete'), child: const Text('Finalizar viaje')),
        ];
      case 'completed':
        final s = _summary;
        return [
          Text('Viaje finalizado. Cobra $fare en efectivo.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
          if (s != null && s['commissionCents'] != null)
            Text('Comisión descontada de tu billetera: ${formatCents(s['commissionCents'] as int)}', textAlign: TextAlign.center),
          if (s != null && s['balanceCents'] != null)
            Text('Saldo actual: ${formatCents(s['balanceCents'] as int)}', textAlign: TextAlign.center),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Listo')),
        ];
      default:
        return [
          const Text('Este viaje ya no está activo.', textAlign: TextAlign.center),
          FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Volver')),
        ];
    }
  }
}
