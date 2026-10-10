import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../config.dart';
import '../core/services.dart';
import '../core/validators.dart';
import '../widgets/common.dart';
import 'menu_screen.dart';
import 'order_screen.dart';

/// Confirmación del pedido: dirección en el mapa, costo de envío y total.
class CheckoutScreen extends StatefulWidget {
  const CheckoutScreen({super.key, required this.merchant, required this.lines});

  final Map<String, dynamic> merchant;
  final List<CartLine> lines;

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _map = MapController();
  final _address = TextEditingController();
  final _note = TextEditingController();
  LatLng? _destination;
  Map<String, dynamic>? _quote;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final pos = await currentPosition();
      if (pos == null || !mounted) return;
      final here = LatLng(pos.latitude, pos.longitude);
      setState(() => _destination ??= here);
      _map.move(here, 17);
    });
  }

  @override
  void dispose() {
    _address.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _getQuote() async {
    if (_destination == null || _address.text.trim().length < 3) {
      showMessage(context, 'Marca tu ubicación en el mapa y escribe una referencia de la dirección');
      return;
    }
    setState(() => _busy = true);
    try {
      final q = await Services.of(context).api.post('/api/orders/quote', {
        'merchantId': widget.merchant['id'],
        'items': [
          for (final l in widget.lines) {'itemId': l.item['id'], 'qty': l.qty, if (l.note != null && l.note!.isNotEmpty) 'note': l.note},
        ],
        'destination': {'lat': _destination!.latitude, 'lng': _destination!.longitude},
        'destinationLabel': _address.text.trim(),
      });
      setState(() => _quote = Map<String, dynamic>.from(q as Map));
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _place() async {
    setState(() => _busy = true);
    try {
      final order = await Services.of(context).api.post('/api/orders', {
        'quoteId': _quote!['quoteId'],
        if (_note.text.trim().isNotEmpty) 'note': _note.text.trim(),
      });
      if (!mounted) return;
      Navigator.of(context).popUntil((r) => r.isFirst);
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => OrderScreen(orderId: (order as Map)['id'] as String)));
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _quote;
    return Scaffold(
      appBar: AppBar(title: Text('Tu pedido en ${widget.merchant['name']}')),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        for (final l in widget.lines)
          ListTile(
            dense: true,
            title: Text('${l.qty} × ${l.item['name']}'),
            trailing: Text(formatCents(l.totalCents)),
            subtitle: TextField(
              decoration: const InputDecoration(hintText: 'Indicación (opcional)', isDense: true, border: InputBorder.none),
              onChanged: (v) {
                l.note = v.trim();
                _quote = null;
              },
            ),
          ),
        const SizedBox(height: 8),
        const Text('¿Dónde te lo entregamos? Toca el mapa para ajustar el punto.'),
        const SizedBox(height: 8),
        SizedBox(
          height: 220,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: FlutterMap(
              mapController: _map,
              options: MapOptions(
                initialCenter: AppConfig.mantaCenter,
                initialZoom: 15,
                onTap: (_, p) => setState(() {
                  _destination = p;
                  _quote = null;
                }),
              ),
              children: [
                baseTiles(),
                MarkerLayer(markers: [if (_destination != null) pin(_destination!, Icons.location_on, Colors.red)]),
              ],
            ),
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _address,
          decoration: const InputDecoration(labelText: 'Dirección y referencia', hintText: 'Calle, número, color de la casa…'),
          onChanged: (_) => _quote = null,
        ),
        const SizedBox(height: 8),
        TextField(controller: _note, decoration: const InputDecoration(labelText: 'Nota para el local (opcional)')),
        const SizedBox(height: 16),
        if (q == null)
          FilledButton(onPressed: _busy ? null : _getQuote, child: const Text('Calcular envío'))
        else ...[
          _row('Productos', formatCents(q['subtotalCents'] as int)),
          _row('Envío en moto', formatCents(q['deliveryFeeCents'] as int)),
          if (q['raining'] == true) const Text('Incluye recargo por lluvia', style: TextStyle(fontSize: 12)),
          const Divider(),
          _row('Total a pagar en efectivo al recibir', formatCents(q['totalCents'] as int), bold: true),
          const SizedBox(height: 12),
          FilledButton(onPressed: _busy ? null : _place, child: const Text('Confirmar pedido')),
        ],
      ]),
    );
  }

  Widget _row(String a, String b, {bool bold = false}) {
    final style = bold ? const TextStyle(fontWeight: FontWeight.bold) : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Flexible(child: Text(a, style: style)), Text(b, style: style)]),
    );
  }
}
