import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:image_picker/image_picker.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../widgets/common.dart';
import 'location_service.dart';

/// Servicio en curso del conductor (viaje, envío o delivery):
/// llegar, recoger (PIN / foto / pedido listo), entregar (PIN de entrega / foto) y cobrar.
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
  String get _service => (_trip['service'] as String?) ?? 'ride';
  Map get _photos => (_trip['photos'] as Map?) ?? const {};

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  Future<void> _action(String path, [Map<String, dynamic>? body]) async {
    setState(() => _busy = true);
    try {
      final res = Map<String, dynamic>.from(await Services.of(context).api.post('/api/trips/$_id/$path', body) as Map);
      _pin.clear();
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

  Future<void> _photo(String stage) async {
    final file = await ImagePicker().pickImage(source: ImageSource.camera, maxWidth: 1600, maxHeight: 1600, imageQuality: 80);
    if (file == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final api = Services.of(context).api;
      await api.upload('PUT', '/api/trips/$_id/photos/$stage', fields: {}, fileField: 'file', bytes: await file.readAsBytes());
      final t = await api.get('/api/trips/$_id');
      if (mounted) setState(() => _trip = Map<String, dynamic>.from(t as Map));
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
        for (final r in ['El cliente no llegó', 'Problema con la moto', 'Dirección peligrosa', 'Paquete sospechoso', 'Otro'])
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
    final title = switch (_service) {
      'parcel' => 'Envío',
      'food' => 'Delivery · ${(_trip['order'] as Map?)?['merchantName'] ?? ''}',
      _ => passenger?['firstName'] != null ? 'Pasajero: ${passenger!['firstName']}' : 'Viaje',
    };

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [if (_status != 'completed' && _status != 'cancelled') SosButton(tripId: _id)],
      ),
      body: Column(children: [
        Expanded(
          child: ValueListenableBuilder<LatLng?>(
            valueListenable: widget.location.current,
            builder: (context, here, _) => FlutterMap(
              options: MapOptions(initialCenter: here ?? pickup, initialZoom: 15),
              children: [
                baseTiles(),
                MarkerLayer(markers: [
                  pin(pickup, _service == 'food' ? Icons.storefront : Icons.trip_origin, Colors.green),
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
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.55),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: _controls(target)),
            ),
          ),
        ),
      ]),
    );
  }

  Widget _pinField(String label) => TextField(
        controller: _pin,
        keyboardType: TextInputType.number,
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 28, letterSpacing: 8),
        inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
        decoration: InputDecoration(labelText: label),
      );

  Widget _photoButton(String stage, String label) {
    final done = _photos[stage] == true;
    return OutlinedButton.icon(
      onPressed: _busy ? null : () => _photo(stage),
      icon: Icon(done ? Icons.check_circle : Icons.photo_camera, color: done ? Colors.green : null),
      label: Text(done ? '$label (tomada, repetir)' : label),
    );
  }

  List<Widget> _details() {
    final parcel = _trip['parcel'] as Map?;
    final order = _trip['order'] as Map?;
    return [
      if (parcel != null) ...[
        Text('Paquete: ${parcel['description']} · ${parcel['size']} · ${parcel['weightKg']} kg'),
        Text('Para: ${parcel['recipientName']} · ${parcel['recipientPhone']}'),
        if (_status == 'in_progress')
          TextButton.icon(
            onPressed: () => launchUrl(Uri.parse('tel:${parcel['recipientPhone']}')),
            icon: const Icon(Icons.call),
            label: const Text('Llamar a quien recibe'),
          ),
      ],
      if (order != null) ...[
        Text('Pedido #${order['code']} · ${(order['items'] as List).length} productos'),
        for (final i in (order['items'] as List)) Text('  ${i['qty']} × ${i['name']}${i['note'] != null ? ' (${i['note']})' : ''}'),
      ],
    ];
  }

  List<Widget> _controls(LatLng target) {
    final fare = formatCents(_trip['fareCents'] as int);
    final collect = formatCents((_trip['collectCents'] ?? _trip['fareCents']) as int);
    final collectAtPickup = _trip['collectAt'] == 'pickup';
    switch (_status) {
      case 'accepted':
        return [
          Text(
            switch (_service) {
              'parcel' => 'Ve a recoger el paquete · Ganas $fare',
              'food' => 'Ve al local · Lleva ${formatCents(_trip['payMerchantCents'] as int)} para pagar el pedido',
              _ => 'Ve a recoger al pasajero · Tarifa $fare',
            },
            textAlign: TextAlign.center,
          ),
          ..._details(),
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: () => _navigate(target), icon: const Icon(Icons.navigation), label: const Text('Navegar')),
          FilledButton(onPressed: _busy ? null : () => _action('arrived'), child: const Text('Llegué')),
          TextButton(onPressed: _cancel, child: const Text('Cancelar')),
        ];
      case 'arrived':
        return [
          ..._details(),
          if (_service == 'food') ...[
            Text('Paga ${formatCents(_trip['payMerchantCents'] as int)} al local y verifica los productos.', textAlign: TextAlign.center,
                style: const TextStyle(fontWeight: FontWeight.bold)),
            const Text('El local debe marcar el pedido como listo en su panel.', textAlign: TextAlign.center),
            FilledButton(onPressed: _busy ? null : () => _action('start'), child: const Text('Recogí el pedido')),
          ] else ...[
            if (_service == 'parcel') ...[
              const Text('Revisa el paquete y toma una foto antes de recogerlo.', textAlign: TextAlign.center),
              _photoButton('pickup', 'Foto del paquete'),
              if (collectAtPickup) Text('Cobra $collect al remitente.', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.bold)),
            ],
            Text(_service == 'parcel' ? 'Pide al remitente el PIN de su app.' : 'Pide al pasajero el PIN de 4 dígitos de su app.', textAlign: TextAlign.center),
            _pinField(_service == 'parcel' ? 'PIN del remitente' : 'PIN del pasajero'),
            FilledButton(
              onPressed: _busy ? null : () => _action('start', {'pin': _pin.text}),
              child: Text(_service == 'parcel' ? 'Recogí el paquete' : 'Iniciar viaje'),
            ),
          ],
          TextButton(onPressed: _cancel, child: const Text('Cancelar')),
        ];
      case 'in_progress':
        if (_service == 'ride') {
          return [
            Text('Rumbo al destino · Cobra $fare en efectivo', textAlign: TextAlign.center),
            OutlinedButton.icon(onPressed: () => _navigate(target), icon: const Icon(Icons.navigation), label: const Text('Navegar')),
            FilledButton(onPressed: _busy ? null : () => _action('complete'), child: const Text('Finalizar viaje')),
          ];
        }
        return [
          ..._details(),
          OutlinedButton.icon(onPressed: () => _navigate(target), icon: const Icon(Icons.navigation), label: const Text('Navegar')),
          if (!collectAtPickup) Text('Cobra $collect en efectivo al entregar', textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.bold)),
          if (_service == 'parcel') _photoButton('dropoff', 'Foto de la entrega'),
          Text(_service == 'parcel' ? 'Pide a quien recibe el PIN que le llegó por SMS.' : 'Pide al cliente el PIN de entrega de su app.',
              textAlign: TextAlign.center),
          _pinField('PIN de entrega'),
          FilledButton(onPressed: _busy ? null : () => _action('complete', {'pin': _pin.text}), child: const Text('Entregado')),
        ];
      case 'completed':
        final s = _summary;
        return [
          Text(_service == 'ride' ? 'Viaje finalizado.' : 'Entrega completada.', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
          if (s != null && s['commissionCents'] != null)
            Text('Comisión descontada de tu billetera: ${formatCents(s['commissionCents'] as int)}', textAlign: TextAlign.center),
          if (s != null && s['balanceCents'] != null) Text('Saldo actual: ${formatCents(s['balanceCents'] as int)}', textAlign: TextAlign.center),
          const SizedBox(height: 12),
          FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Listo')),
        ];
      default:
        return [
          const Text('Este servicio ya no está activo.', textAlign: TextAlign.center),
          FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Volver')),
        ];
    }
  }
}
