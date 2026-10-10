import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../config.dart';
import '../core/geo.dart';
import '../core/realtime.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../widgets/common.dart';

const _statusText = {
  'searching': 'Buscando una moto cerca de ti…',
  'accepted': 'Tu conductor va en camino',
  'arrived': 'Tu conductor llegó al punto de recogida',
  'in_progress': 'Viaje en curso',
  'completed': 'Llegaste a tu destino',
  'cancelled': 'Viaje cancelado',
  'expired': 'No encontramos conductor disponible',
};

/// Viaje del pasajero en tiempo real: moto en el mapa, PIN de abordaje,
/// compartir viaje, SOS, cancelar y calificar.
class TripScreen extends StatefulWidget {
  const TripScreen({super.key, required this.initial});

  final Map<String, dynamic> initial;

  @override
  State<TripScreen> createState() => _TripScreenState();
}

class _TripScreenState extends State<TripScreen> {
  late Map<String, dynamic> _trip = widget.initial;
  final _map = MapController();
  LatLng? _driver;
  StreamSubscription<RealtimeEvent>? _sub;
  int _searchRound = 0;
  bool _rated = false;

  String get _id => _trip['id'] as String;
  String get _status => _trip['status'] as String;
  bool get _active => const ['searching', 'accepted', 'arrived', 'in_progress'].contains(_status);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_sub != null) return;
    final services = Services.of(context);
    _sub = services.realtime.events.listen(_onEvent);
    services.realtime.watchTrip(_id);
    _applyDriverLocation(_trip);
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  void _onEvent(RealtimeEvent e) {
    if (!mounted) return;
    switch (e.name) {
      case 'connected':
        Services.of(context).realtime.watchTrip(_id);
        _reload();
      case 'trip:update':
        final t = Map<String, dynamic>.from(e.data as Map);
        if (t['id'] != _id) return;
        setState(() => _trip = t);
        _applyDriverLocation(t);
        if (t['status'] == 'accepted') Services.of(context).realtime.watchTrip(_id);
      case 'trip:searching':
        setState(() => _searchRound = (e.data as Map)['round'] as int);
      case 'dloc':
        final p = e.data as List;
        setState(() => _driver = LatLng(fromE5(p[0] as num), fromE5(p[1] as num)));
    }
  }

  void _applyDriverLocation(Map<String, dynamic> t) {
    final loc = (t['driver'] as Map?)?['location'] as Map?;
    if (loc != null) _driver = LatLng((loc['lat'] as num).toDouble(), (loc['lng'] as num).toDouble());
  }

  Future<void> _reload() async {
    try {
      final t = Map<String, dynamic>.from(await Services.of(context).api.get('/api/trips/$_id') as Map);
      if (mounted) setState(() => _trip = t);
    } catch (_) {}
  }

  Future<void> _share() async {
    try {
      final res = await Services.of(context).api.post('/api/trips/$_id/share');
      await Clipboard.setData(ClipboardData(text: res['url'] as String));
      if (mounted) showMessage(context, 'Link de seguimiento copiado. Envíalo a tu familia por WhatsApp.');
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _cancel() async {
    try {
      final t = await Services.of(context).api.post('/api/trips/$_id/cancel', {});
      if (mounted) setState(() => _trip = Map<String, dynamic>.from(t as Map));
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _rate(int stars) async {
    try {
      await Services.of(context).api.post('/api/trips/$_id/rate', {'stars': stars});
      setState(() => _rated = true);
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final origin = _trip['origin'] as Map;
    final dest = _trip['destination'] as Map;
    final pickup = LatLng((origin['lat'] as num).toDouble(), (origin['lng'] as num).toDouble());
    final dropoff = LatLng((dest['lat'] as num).toDouble(), (dest['lng'] as num).toDouble());
    final driver = _trip['driver'] as Map?;
    return Scaffold(
      appBar: AppBar(title: Text(_statusText[_status] ?? _status)),
      floatingActionButton: _active ? SosButton(tripId: _id) : null,
      floatingActionButtonLocation: FloatingActionButtonLocation.endTop,
      body: Column(children: [
        Expanded(
          child: FlutterMap(
            mapController: _map,
            options: MapOptions(initialCenter: pickup, initialZoom: 15),
            children: [
              baseTiles(),
              MarkerLayer(markers: [
                pin(pickup, Icons.trip_origin, Colors.green),
                pin(dropoff, Icons.location_on, Colors.red),
                if (_driver != null && _active) pin(_driver!, Icons.two_wheeler, Colors.black, size: 36),
              ]),
              const RichAttributionWidget(attributions: [TextSourceAttribution(AppConfig.tileAttribution)]),
            ],
          ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              if (_status == 'searching')
                Text('Avisando a motos cercanas… (ronda ${_searchRound == 0 ? 1 : _searchRound})', textAlign: TextAlign.center),
              if (_trip['pin'] != null) ...[
                const Text('Dile este PIN al conductor al subir:', textAlign: TextAlign.center),
                Text(_trip['pin'] as String,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.displaySmall?.copyWith(letterSpacing: 8, fontWeight: FontWeight.bold)),
                const Text('Verifica que la placa coincida antes de subir.', textAlign: TextAlign.center, style: TextStyle(fontSize: 12)),
              ],
              if (driver != null)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const CircleAvatar(child: Icon(Icons.two_wheeler)),
                  title: Text('${driver['firstName'] ?? ''} · ${driver['plate'] ?? ''}'),
                  subtitle: Text('${driver['moto'] ?? ''}${driver['rating'] != null ? ' · ★ ${driver['rating']}' : ''}'),
                ),
              Text('Total: ${formatCents(_trip['fareCents'] as int)} en efectivo', textAlign: TextAlign.center),
              const SizedBox(height: 8),
              if (_active)
                Row(children: [
                  Expanded(child: OutlinedButton.icon(onPressed: _share, icon: const Icon(Icons.share_location), label: const Text('Compartir'))),
                  if (_status != 'in_progress') ...[
                    const SizedBox(width: 8),
                    Expanded(child: OutlinedButton(onPressed: _cancel, child: const Text('Cancelar'))),
                  ],
                ]),
              if (_status == 'completed' && !_rated) ...[
                const Text('¿Cómo estuvo tu viaje?', textAlign: TextAlign.center),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [for (var i = 1; i <= 5; i++) IconButton(icon: const Icon(Icons.star_border), onPressed: () => _rate(i))],
                ),
              ],
              if (!_active)
                FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Volver al inicio')),
            ]),
          ),
        ),
      ]),
    );
  }
}
