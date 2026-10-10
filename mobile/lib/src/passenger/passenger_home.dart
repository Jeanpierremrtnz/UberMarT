import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../config.dart';
import '../core/geo.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../food/merchants_screen.dart';
import '../shared/activity_screen.dart';
import '../shared/emergency_contacts_screen.dart';
import '../widgets/common.dart';
import 'parcel_form.dart';
import 'trip_screen.dart';

/// Inicio del cliente: viaje en moto, envío (mensajería) o delivery de comida.
class PassengerHome extends StatefulWidget {
  const PassengerHome({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<PassengerHome> createState() => _PassengerHomeState();
}

class _PassengerHomeState extends State<PassengerHome> {
  final _map = MapController();
  String _service = 'ride';
  LatLng? _pickup;
  LatLng? _dropoff;
  bool _choosingPickup = true;
  Map<String, dynamic>? _parcel;
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
      if (trip != null && trip['service'] == 'ride' && mounted) _openTrip(Map<String, dynamic>.from(trip as Map));
    } catch (_) {/* sin viaje activo */}
  }

  Future<void> _locate() async {
    final pos = await currentPosition();
    if (pos == null || !mounted) return;
    final here = LatLng(pos.latitude, pos.longitude);
    setState(() => _pickup ??= here);
    _map.move(here, 16);
  }

  void _selectService(String service) {
    if (service == 'food') {
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => const MerchantsScreen()));
      return;
    }
    setState(() {
      _service = service;
      _quote = null;
      _route = const [];
    });
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
    if (_service == 'parcel') {
      final parcel = await showParcelForm(context, initial: _parcel);
      if (parcel == null) return;
      _parcel = parcel;
    }
    if (!mounted) return;
    setState(() => _busy = true);
    try {
      final q = Map<String, dynamic>.from(await Services.of(context).api.post('/api/trips/quote', {
        'service': _service,
        'origin': {'lat': _pickup!.latitude, 'lng': _pickup!.longitude},
        'destination': {'lat': _dropoff!.latitude, 'lng': _dropoff!.longitude},
        if (_service == 'parcel') 'parcel': _parcel,
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

  Future<void> _request() async {
    setState(() => _busy = true);
    try {
      final trip = await Services.of(context).api.post('/api/trips', {'quoteId': _quote!['quoteId']});
      if (!mounted) return;
      setState(() {
        _quote = null;
        _dropoff = null;
        _parcel = null;
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
            tooltip: 'Mis envíos y pedidos',
            icon: const Icon(Icons.receipt_long),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const ActivityScreen())),
          ),
          IconButton(
            tooltip: 'Contactos de emergencia',
            icon: const Icon(Icons.health_and_safety),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const EmergencyContactsScreen())),
          ),
          IconButton(tooltip: 'Salir', icon: const Icon(Icons.logout), onPressed: () => services.session.clear()),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(56),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'ride', label: Text('Viaje'), icon: Icon(Icons.two_wheeler)),
                ButtonSegment(value: 'parcel', label: Text('Envío'), icon: Icon(Icons.inventory_2)),
                ButtonSegment(value: 'food', label: Text('Comida'), icon: Icon(Icons.restaurant)),
              ],
              selected: {_service},
              onSelectionChanged: (s) => _selectService(s.first),
            ),
          ),
        ),
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
              segments: [
                ButtonSegment(value: true, label: Text(_service == 'parcel' ? 'Recoger en' : 'Recogida'), icon: const Icon(Icons.trip_origin)),
                ButtonSegment(value: false, label: Text(_service == 'parcel' ? 'Entregar en' : 'Destino'), icon: const Icon(Icons.location_on)),
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
    final isParcel = _service == 'parcel';
    return Card(
      margin: const EdgeInsets.all(12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: q == null
            ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(_dropoff == null
                    ? (isParcel ? 'Marca en el mapa dónde recoger y dónde entregar' : 'Toca el mapa para marcar tu destino')
                    : 'Listo para cotizar'),
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: _busy || _pickup == null || _dropoff == null ? null : _getQuote,
                  child: Text(isParcel ? 'Datos del paquete y tarifa' : 'Ver tarifa'),
                ),
              ])
            : _QuoteView(quote: q, busy: _busy, onRequest: _request, isParcel: isParcel),
      ),
    );
  }
}

/// Tarifa transparente: total y desglose (base, distancia, tiempo, multiplicador, lluvia).
class _QuoteView extends StatelessWidget {
  const _QuoteView({required this.quote, required this.busy, required this.onRequest, required this.isParcel});

  final Map<String, dynamic> quote;
  final bool busy;
  final VoidCallback onRequest;
  final bool isParcel;

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
      FilledButton(onPressed: busy ? null : onRequest, child: Text(isParcel ? 'Enviar paquete' : 'Pedir moto')),
    ]);
  }
}
