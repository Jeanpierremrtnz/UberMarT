import 'package:flutter/material.dart';

import '../core/services.dart';
import '../core/validators.dart';
import '../food/order_screen.dart';
import '../passenger/trip_screen.dart';

const _serviceIcons = {'ride': Icons.two_wheeler, 'parcel': Icons.inventory_2, 'food': Icons.restaurant};
const _tripStatus = {'searching': 'Buscando moto', 'accepted': 'Motorizado asignado', 'arrived': 'Recogiendo', 'in_progress': 'En camino'};
const _orderStatus = {
  'placed': 'Esperando al local',
  'accepted': 'En preparación',
  'ready': 'Listo para retirar',
  'picked_up': 'En camino',
  'delivered': 'Entregado',
  'rejected': 'Rechazado',
  'cancelled': 'Cancelado',
};

/// Envíos y pedidos del cliente (puede tener varios en curso a la vez).
class ActivityScreen extends StatefulWidget {
  const ActivityScreen({super.key});

  @override
  State<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends State<ActivityScreen> {
  List<Map<String, dynamic>> _active = [];
  List<Map<String, dynamic>> _orders = [];
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = Services.of(context).api;
    try {
      final active = await api.get('/api/trips/active') as List;
      final orders = await api.get('/api/orders') as List;
      if (!mounted) return;
      setState(() {
        _active = active.map((e) => Map<String, dynamic>.from(e as Map)).where((t) => t['service'] != 'food').toList();
        _orders = orders.map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _loaded = true;
      });
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Mis envíos y pedidos')),
      body: !_loaded
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.all(12), children: [
                if (_active.isNotEmpty) Text('En curso', style: Theme.of(context).textTheme.titleMedium),
                for (final t in _active)
                  ListTile(
                    leading: Icon(_serviceIcons[t['service']] ?? Icons.two_wheeler),
                    title: Text(t['service'] == 'parcel' ? 'Envío a ${(t['parcel'] as Map?)?['recipientName'] ?? ''}' : 'Viaje'),
                    subtitle: Text('${_tripStatus[t['status']] ?? t['status']} · ${formatCents(t['fareCents'] as int)}'),
                    onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => TripScreen(initial: t))).then((_) => _load()),
                  ),
                Text('Pedidos de comida', style: Theme.of(context).textTheme.titleMedium),
                if (_orders.isEmpty) const Padding(padding: EdgeInsets.all(12), child: Text('Aún no tienes pedidos.')),
                for (final o in _orders)
                  ListTile(
                    leading: const Icon(Icons.restaurant),
                    title: Text('${(o['merchant'] as Map)['name']} · #${o['code']}'),
                    subtitle: Text('${_orderStatus[o['status']] ?? o['status']} · ${formatCents(o['totalCents'] as int)}'),
                    onTap: () => Navigator.of(context)
                        .push(MaterialPageRoute(builder: (_) => OrderScreen(orderId: o['id'] as String)))
                        .then((_) => _load()),
                  ),
              ]),
            ),
    );
  }
}
