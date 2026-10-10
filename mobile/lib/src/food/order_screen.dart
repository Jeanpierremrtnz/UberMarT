import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/realtime.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../passenger/trip_screen.dart';

const _steps = ['placed', 'accepted', 'ready', 'picked_up', 'delivered'];
const _labels = {
  'placed': 'Esperando que el local acepte',
  'accepted': 'El local está preparando tu pedido',
  'ready': 'Pedido listo, el motorizado lo retira',
  'picked_up': 'Tu pedido va en camino',
  'delivered': 'Pedido entregado',
  'rejected': 'El local no pudo aceptar tu pedido',
  'cancelled': 'Pedido cancelado',
};
const _reasons = {
  'sin_stock': 'Sin stock',
  'cerrando': 'El local está cerrando',
  'demasiados_pedidos': 'El local tiene demasiados pedidos',
  'direccion_fuera_de_zona': 'Dirección fuera de su zona',
  'sin_respuesta_del_local': 'El local no respondió a tiempo',
  'sin_motorizado': 'No encontramos motorizado disponible',
  'cancelado_por_cliente': 'Lo cancelaste',
};

/// Estado del pedido en vivo, con PIN de entrega y acceso al mapa del motorizado.
class OrderScreen extends StatefulWidget {
  const OrderScreen({super.key, required this.orderId});

  final String orderId;

  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> {
  Map<String, dynamic>? _order;
  StreamSubscription<RealtimeEvent>? _sub;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_sub != null) return;
    _sub = Services.of(context).realtime.events.listen((e) {
      if (!mounted) return;
      if (e.name == 'order:update' && (e.data as Map)['id'] == widget.orderId) {
        setState(() => _order = Map<String, dynamic>.from(e.data as Map));
      } else if (e.name == 'connected') {
        _load();
      }
    });
    _load();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final o = await Services.of(context).api.get('/api/orders/${widget.orderId}');
      if (mounted) setState(() => _order = Map<String, dynamic>.from(o as Map));
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _cancel() async {
    try {
      final o = await Services.of(context).api.post('/api/orders/${widget.orderId}/cancel');
      if (mounted) setState(() => _order = Map<String, dynamic>.from(o as Map));
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _track() async {
    final trip = await Services.of(context).api.get('/api/trips/${_order!['tripId']}');
    if (!mounted) return;
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => TripScreen(initial: Map<String, dynamic>.from(trip as Map))));
  }

  @override
  Widget build(BuildContext context) {
    final o = _order;
    if (o == null) return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
    final status = o['status'] as String;
    final step = _steps.indexOf(status);
    final merchant = o['merchant'] as Map;
    final driver = o['driver'] as Map?;
    return Scaffold(
      appBar: AppBar(title: Text('Pedido #${o['code']}')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Text(merchant['name'] as String, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        Text(_labels[status] ?? status, style: Theme.of(context).textTheme.titleMedium),
        if (o['statusReason'] != null) Text(_reasons[o['statusReason']] ?? '${o['statusReason']}'),
        const SizedBox(height: 8),
        if (step >= 0) LinearProgressIndicator(value: (step + 1) / _steps.length),
        if (o['deliveryPin'] != null) ...[
          const SizedBox(height: 16),
          const Text('Tu PIN de entrega: díselo al motorizado solo cuando tengas tu pedido en la mano', textAlign: TextAlign.center),
          Text(o['deliveryPin'] as String,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.displaySmall?.copyWith(letterSpacing: 8, fontWeight: FontWeight.bold)),
        ],
        if (driver != null)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const CircleAvatar(child: Icon(Icons.two_wheeler)),
            title: Text('${driver['firstName']} · ${driver['plate']}'),
            subtitle: Text(driver['moto'] as String? ?? ''),
            trailing: o['tripId'] != null ? FilledButton.tonal(onPressed: _track, child: const Text('Ver en el mapa')) : null,
          ),
        const Divider(),
        for (final i in (o['items'] as List))
          Text('${i['qty']} × ${i['name']}${i['note'] != null ? ' (${i['note']})' : ''}'),
        const SizedBox(height: 8),
        Text('Productos: ${formatCents(o['subtotalCents'] as int)} · Envío: ${formatCents(o['deliveryFeeCents'] as int)}'),
        Text('Total a pagar en efectivo: ${formatCents(o['totalCents'] as int)}', style: const TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 16),
        if (merchant['phone'] != null)
          OutlinedButton.icon(
            onPressed: () => launchUrl(Uri.parse('tel:${merchant['phone']}')),
            icon: const Icon(Icons.call),
            label: const Text('Llamar al local'),
          ),
        if (status == 'placed') TextButton(onPressed: _cancel, child: const Text('Cancelar pedido')),
      ]),
    );
  }
}
