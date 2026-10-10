import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../config.dart';
import '../core/geo.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../shared/emergency_contacts_screen.dart';
import '../widgets/common.dart';
import 'trip_screen.dart';

/// Inicio del pasajero: marcar recogida y destino en el mapa, cotizar y pedir.
class PassengerHome extends StatefulWidget {
  const PassengerHome({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<PassengerHome> createState() => _PassengerHomeState();
}

class _PassengerHomeState extends State<PassengerHome> {
  final _map = MapController();
  LatLng? _pickup;
  LatLng? _dropoff;
  bool _choosingPickup = true;
  Map<String, dynamic>? _quote;
  List<LatLng> _route = const [];
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _resumeActiveTrip();
      _locate();
    });
  }

  Future<void> _resumeActiveTrip() async {
    try {
      final res = await Services.of(context).api.get('/api/trips/current');
      final trip = res['trip'];
      if (trip != null && mounted) _openTrip(Map<String, dynamic>.from(trip as Map));
    } catch (_) {/* sin viaje activo */}
  }

  Future<void> _locate() async {
    final pos = await currentPosition().catchError((_) => null);
    if (pos == null || !mounted) return;
    final here = LatLng(pos.latitude, pos.longitude);
    setState(() => _pickup ??= here);
    _map.move(here, 16);
  }

  void _onTap(TapPosition _, LatLng point) {
    setState(() {
      if (_choosingPickup) {
        _pickup = point;
        _choosingPickup = false;
      } else {
        _dropoff = point;
      }
      _quote = null;
      _route = const [];
    });
  }

  Future<void> _getQuote() async {
    if (_pickup == null || _dropoff == null) return;
    setState(() => _busy = true);
    try {
      final q = Map<String, dynamic>.from(await Services.of(context).api.post('/api/trips/quote', {
        'origin': {'lat': _pickup!.latitude, 'lng': _pickup!.longitude},
        'destination': {'lat': _dropoff!.latitude, 'lng': _dropoff!.longitude},
      }) as Map);
      setState(() {
        _quote = q;
        _route = q['polyline'] is String ? decodePolyline(q['polyline'] as String) : [_pickup!, _dropoff!];
      });
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _requestTrip() async {
    setState(() => _busy = true);
    try {
      final trip = await Services.of(context).api.post('/api/trips', {'quoteId': _quote!['quoteId']});
      if (!mounted) return;
      setState(() {
        _quote = null;
        _dropoff = null;
        _route = const [];
      });
      _openTrip(Map<String, dynamic>.from(trip as Map));
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _openTrip(Map<String, dynamic> trip) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => TripScreen(initial: trip)));
  }

  @override
  Widget build(BuildContext context) {
    final services = Services.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text('Hola, ${(widget.profile['fullName'] as String? ?? '').split(' ').first}'),
        actions: [
          IconButton(
            tooltip: 'Contactos de emergencia',
            icon: const Icon(Icons.health_and_safety),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const EmergencyContactsScreen())),
          ),
          IconButton(tooltip: 'Salir', icon: const Icon(Icons.logout), onPressed: () => services.session.clear()),
        ],
      ),
      body: Stack(
        children: [
          FlutterMap(
            mapController: _map,
            options: MapOptions(initialCenter: AppConfig.mantaCenter, initialZoom: 14, onTap: _onTap),
            children: [
              baseTiles(),
              if (_route.isNotEmpty) PolylineLayer(polylines: [Polyline(points: _route, strokeWidth: 5, color: Colors.blue)]),
              MarkerLayer(markers: [
                if (_pickup != null) pin(_pickup!, Icons.trip_origin, Colors.green),
                if (_dropoff != null) pin(_dropoff!, Icons.location_on, Colors.red),
              ]),
              const RichAttributionWidget(attributions: [TextSourceAttribution(AppConfig.tileAttribution)]),
            ],
          ),
          Positioned(
            top: 12,
            left: 12,
            right: 12,
            child: SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('Recogida'), icon: Icon(Icons.trip_origin)),
                ButtonSegment(value: false, label: Text('Destino'), icon: Icon(Icons.location_on)),
              ],
              selected: {_choosingPickup},
              onSelectionChanged: (s) => setState(() => _choosingPickup = s.first),
            ),
          ),
          Align(alignment: Alignment.bottomCenter, child: _bottomCard()),
        ],
      ),
    );
  }

  Widget _bottomCard() {
    final q = _quote;
    return Card(
      margin: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: q == null
            ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(_dropoff == null ? 'Toca el mapa para marcar tu destino' : 'Listo para cotizar'),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _busy || _pickup == null || _dropoff == null ? null : _getQuote,
                  child: const Text('Ver tarifa'),
                ),
              ])
            : _QuoteView(quote: q, busy: _busy, onRequest: _requestTrip),
      ),
    );
  }
}

/// Tarifa transparente: total y desglose (base, distancia, tiempo, multiplicador, lluvia).
class _QuoteView extends StatelessWidget {
  const _QuoteView({required this.quote, required this.busy, required this.onRequest});

  final Map<String, dynamic> quote;
  final bool busy;
  final VoidCallback onRequest;

  @override
  Widget build(BuildContext context) {
    final b = Map<String, dynamic>.from(quote['breakdown'] as Map);
    final multiplier = (b['multiplier'] as num).toDouble();
    final rain = b['rainSurchargeCents'] as int;
    final eta = quote['pickupEtaMin'];
    Widget row(String label, String value) =>
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(label), Text(value)]);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(formatCents(quote['totalCents'] as int), style: Theme.of(context).textTheme.headlineMedium, textAlign: TextAlign.center),
      Text('${b['km']} km · ~${b['minutes']} min · Pago en efectivo', textAlign: TextAlign.center),
      const Divider(),
      row('Tarifa base', formatCents(b['baseCents'] as int)),
      row('Distancia', formatCents(b['distanceCents'] as int)),
      row('Tiempo', formatCents(b['timeCents'] as int)),
      if (multiplier > 1) row(b['multiplierSource'] == 'zona' ? 'Alta demanda en la zona' : 'Hora pico', '×${multiplier.toStringAsFixed(1)}'),
      if (rain > 0) row('Recargo por lluvia', '+${formatCents(rain)}'),
      if (b['minFareApplied'] == true) row('Tarifa mínima aplicada', ''),
      const SizedBox(height: 8),
      Text(
        quote['driversNearby'] == 0
            ? 'No hay motos cerca ahora, igual buscaremos por ti.'
            : '${quote['driversNearby']} motos cerca${eta != null ? ' · la más cercana a ~$eta min' : ''}',
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 12),
      FilledButton(onPressed: busy ? null : onRequest, child: const Text('Pedir moto')),
    ]);
  }
}
