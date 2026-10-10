import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../config.dart';
import '../core/realtime.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../shared/emergency_contacts_screen.dart';
import '../widgets/common.dart';
import 'driver_trip_screen.dart';
import 'location_service.dart';
import 'registration_screen.dart';
import 'wallet_screen.dart';

/// Inicio del conductor: estado de registro, saldo, conexión y ofertas de viaje.
class DriverHome extends StatefulWidget {
  const DriverHome({super.key, required this.profile});

  final Map<String, dynamic> profile;

  @override
  State<DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<DriverHome> {
  DriverLocationService? _location;
  StreamSubscription<RealtimeEvent>? _sub;
  String? _status;
  bool _online = false;
  bool _busy = false;
  int? _balance;
  int? _minBalance;
  Map<String, dynamic>? _offer;
  Timer? _offerTimer;
  int _offerSecondsLeft = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_sub != null) return;
    final services = Services.of(context);
    _location = DriverLocationService(services.realtime);
    _sub = services.realtime.events.listen(_onEvent);
    _refresh();
  }

  @override
  void dispose() {
    _sub?.cancel();
    _offerTimer?.cancel();
    _location?.stop();
    super.dispose();
  }

  Future<void> _refresh() async {
    final api = Services.of(context).api;
    try {
      final app = await api.get('/api/driver/application');
      final status = app['status'] as String;
      setState(() {
        _status = status;
        _online = app['isOnline'] == true;
      });
      if (status == 'approved') {
        final wallet = await api.get('/api/wallet');
        setState(() {
          _balance = wallet['balanceCents'] as int;
          _minBalance = wallet['minBalanceCents'] as int;
        });
        if (_online) await _location!.start();
        final current = await api.get('/api/trips/current');
        if (current['trip'] != null && mounted) _openTrip(Map<String, dynamic>.from(current['trip'] as Map));
      }
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  void _onEvent(RealtimeEvent e) {
    if (!mounted) return;
    switch (e.name) {
      case 'trip:offer':
        if (!_online) return;
        _showOffer(Map<String, dynamic>.from(e.data as Map));
      case 'trip:offer_closed':
        if (_offer != null && (e.data as Map)['tripId'] == _offer!['tripId']) _clearOffer();
      case 'wallet:update':
        setState(() => _balance = (e.data as Map)['balanceCents'] as int?);
      case 'driver:status':
        _refresh();
      case 'connected':
        _location?.sendNextImmediately();
    }
  }

  void _showOffer(Map<String, dynamic> offer) {
    _offerTimer?.cancel();
    setState(() {
      _offer = offer;
      _offerSecondsLeft = offer['expiresInSec'] as int;
    });
    _offerTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _offerSecondsLeft--);
      if (_offerSecondsLeft <= 0) _clearOffer();
    });
  }

  void _clearOffer() {
    _offerTimer?.cancel();
    if (mounted) setState(() => _offer = null);
  }

  Future<void> _toggleOnline(bool value) async {
    setState(() => _busy = true);
    final api = Services.of(context).api;
    try {
      if (value) {
        final error = await _location!.start();
        if (error != null) throw error;
      }
      await api.post('/api/driver/online', {'online': value});
      if (!value) await _location!.stop();
      setState(() => _online = value);
    } catch (e) {
      await _location!.stop();
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _respond(bool accept) async {
    final offer = _offer;
    if (offer == null) return;
    _clearOffer();
    final api = Services.of(context).api;
    try {
      if (accept) {
        final trip = await api.post('/api/trips/${offer['tripId']}/accept');
        _location?.sendNextImmediately();
        if (mounted) _openTrip(Map<String, dynamic>.from(trip as Map));
      } else {
        await api.post('/api/trips/${offer['tripId']}/decline');
      }
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  void _openTrip(Map<String, dynamic> trip) {
    Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => DriverTripScreen(initial: trip, location: _location!)))
        .then((_) => _refresh());
  }

  @override
  Widget build(BuildContext context) {
    final services = Services.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('UberMarT Conductor'),
        actions: [
          IconButton(
            tooltip: 'Contactos de emergencia',
            icon: const Icon(Icons.health_and_safety),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const EmergencyContactsScreen())),
          ),
          IconButton(
            tooltip: 'Salir',
            icon: const Icon(Icons.logout),
            onPressed: () async {
              if (_online) await _toggleOnline(false);
              await services.session.clear();
            },
          ),
        ],
      ),
      floatingActionButton: _status == 'approved' ? const SosButton() : null,
      body: _status == null ? const Center(child: CircularProgressIndicator()) : _body(),
    );
  }

  Widget _body() {
    if (_status != 'approved') return _registrationState();
    final lowBalance = _balance != null && _minBalance != null && _balance! < _minBalance!;
    return Column(children: [
      Expanded(
        child: ValueListenableBuilder<LatLng?>(
          valueListenable: _location!.current,
          builder: (context, here, _) => FlutterMap(
            options: MapOptions(initialCenter: here ?? AppConfig.mantaCenter, initialZoom: 15),
            children: [
              baseTiles(),
              MarkerLayer(markers: [if (here != null) pin(here, Icons.two_wheeler, Colors.black, size: 36)]),
              const RichAttributionWidget(attributions: [TextSourceAttribution(AppConfig.tileAttribution)]),
            ],
          ),
        ),
      ),
      if (_offer != null) _offerCard(_offer!),
      SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.account_balance_wallet),
              title: Text('Saldo: ${_balance == null ? '…' : formatCents(_balance!)}'),
              subtitle: lowBalance ? Text('Recarga al menos ${formatCents(_minBalance!)} para recibir viajes') : null,
              trailing: FilledButton.tonal(
                onPressed: () => Navigator.of(context)
                    .push(MaterialPageRoute(builder: (_) => const WalletScreen()))
                    .then((_) => _refresh()),
                child: const Text('Recargar'),
              ),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(_online ? 'En línea: recibiendo viajes' : 'Desconectado'),
              value: _online,
              onChanged: _busy ? null : _toggleOnline,
            ),
          ]),
        ),
      ),
    ]);
  }

  Widget _offerCard(Map<String, dynamic> offer) {
    final pickup = offer['pickup'] as Map;
    final dropoff = offer['dropoff'] as Map;
    final service = offer['service'] as String? ?? 'ride';
    final parcel = offer['parcel'] as Map?;
    final food = offer['food'] as Map?;
    final title = switch (service) {
      'parcel' => 'Nuevo envío',
      'food' => 'Nuevo delivery${food?['merchantName'] != null ? ' de ${food!['merchantName']}' : ''}',
      _ => 'Nuevo viaje',
    };
    return Card(
      margin: const EdgeInsets.all(12),
      color: Theme.of(context).colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('$title · Ganas ${formatCents(offer['fareCents'] as int)}', style: Theme.of(context).textTheme.titleLarge),
          Text('Recogida a ${((offer['pickupDistanceM'] as int) / 1000).toStringAsFixed(1)} km: ${pickup['label'] ?? 'punto en el mapa'}'),
          Text('Recorrido de ${((offer['tripDistanceM'] as int) / 1000).toStringAsFixed(1)} km hacia ${dropoff['label'] ?? 'destino en el mapa'}'),
          if (parcel != null) Text('Paquete ${parcel['size']} · ${parcel['weightKg']} kg · ${parcel['description']}'),
          if (food != null)
            Text('Pagas ${formatCents(food['payMerchantCents'] as int)} al local y cobras ${formatCents(offer['collectCents'] as int)} al cliente',
                style: const TextStyle(fontWeight: FontWeight.bold)),
          if (service == 'parcel')
            Text(offer['collectAt'] == 'pickup' ? 'Cobras al recoger el paquete' : 'Cobras al entregar el paquete'),
          const SizedBox(height: 12),
          Row(children: [
            Expanded(child: OutlinedButton(onPressed: () => _respond(false), child: const Text('Rechazar'))),
            const SizedBox(width: 12),
            Expanded(child: FilledButton(onPressed: () => _respond(true), child: Text('Aceptar ($_offerSecondsLeft)'))),
          ]),
        ]),
      ),
    );
  }

  Widget _registrationState() {
    final (title, text, canEdit) = switch (_status) {
      'submitted' => ('Solicitud en revisión', 'Estamos verificando tus documentos. Te avisaremos cuando seas aprobado.', false),
      'rejected' => ('Solicitud rechazada', 'Revisa la observación, corrige tus datos o documentos y vuelve a enviar.', true),
      'suspended' => ('Cuenta suspendida', 'Comunícate con soporte de UberMarT.', false),
      _ => ('Regístrate como conductor', 'Necesitamos tu licencia tipo A, matrícula, antecedentes penales y fotos de tu moto.', true),
    };
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text(title, style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
        const SizedBox(height: 12),
        Text(text, textAlign: TextAlign.center),
        const SizedBox(height: 24),
        if (canEdit)
          FilledButton(
            onPressed: () => Navigator.of(context)
                .push(MaterialPageRoute(builder: (_) => const RegistrationScreen()))
                .then((_) => _refresh()),
            child: const Text('Completar registro'),
          ),
        TextButton(onPressed: _refresh, child: const Text('Actualizar estado')),
      ]),
    );
  }
}
