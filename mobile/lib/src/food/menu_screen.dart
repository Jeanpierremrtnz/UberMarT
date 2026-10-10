import 'package:flutter/material.dart';

import '../config.dart';
import '../core/services.dart';
import '../core/validators.dart';
import 'checkout_screen.dart';

class CartLine {
  CartLine(this.item, {this.qty = 1});

  final Map<String, dynamic> item;
  int qty;
  String? note;

  int get totalCents => (item['priceCents'] as int) * qty;
}

/// Menú de un local con fotos y carrito.
class MenuScreen extends StatefulWidget {
  const MenuScreen({super.key, required this.merchantId});

  final String merchantId;

  @override
  State<MenuScreen> createState() => _MenuScreenState();
}

class _MenuScreenState extends State<MenuScreen> {
  Map<String, dynamic>? _merchant;
  final Map<String, CartLine> _cart = {};

  int get _subtotal => _cart.values.fold(0, (sum, l) => sum + l.totalCents);
  int get _units => _cart.values.fold(0, (sum, l) => sum + l.qty);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    try {
      final m = await Services.of(context).api.get('/api/merchants/${widget.merchantId}');
      if (mounted) setState(() => _merchant = Map<String, dynamic>.from(m as Map));
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  void _add(Map<String, dynamic> item) {
    setState(() {
      final line = _cart[item['id'] as String];
      if (line == null) {
        _cart[item['id'] as String] = CartLine(item);
      } else if (line.qty < 20) {
        line.qty++;
      }
    });
  }

  void _remove(Map<String, dynamic> item) {
    setState(() {
      final line = _cart[item['id'] as String];
      if (line == null) return;
      if (line.qty <= 1) {
        _cart.remove(item['id']);
      } else {
        line.qty--;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final m = _merchant;
    if (m == null) return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
    final items = (m['items'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final categories = <String, List<Map<String, dynamic>>>{};
    for (final i in items) {
      categories.putIfAbsent(i['category'] as String, () => []).add(i);
    }
    return Scaffold(
      appBar: AppBar(title: Text(m['name'] as String)),
      bottomNavigationBar: _cart.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: FilledButton(
                  onPressed: () => Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => CheckoutScreen(merchant: m, lines: _cart.values.toList()),
                  )),
                  child: Text('Ver pedido · $_units productos · ${formatCents(_subtotal)}'),
                ),
              ),
            ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Text('${m['addressLabel']}${m['scheduleText'] != null ? ' · ${m['scheduleText']}' : ''}'),
        Text('Preparación aprox. ${m['prepMinutes']} min', style: Theme.of(context).textTheme.bodySmall),
        for (final entry in categories.entries) ...[
          Padding(
            padding: const EdgeInsets.only(top: 16, bottom: 4),
            child: Text(entry.key, style: Theme.of(context).textTheme.titleMedium),
          ),
          for (final i in entry.value)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: Row(children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: i['photoUrl'] != null
                        ? Image.network('${AppConfig.apiBaseUrl}${i['photoUrl']}', width: 72, height: 72, fit: BoxFit.cover,
                            errorBuilder: (_, _, _) => const SizedBox(width: 72, height: 72, child: Icon(Icons.fastfood)))
                        : const SizedBox(width: 72, height: 72, child: Icon(Icons.fastfood)),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(i['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                      if (i['description'] != null) Text(i['description'] as String, style: Theme.of(context).textTheme.bodySmall),
                      Text(formatCents(i['priceCents'] as int)),
                    ]),
                  ),
                  if (_cart[i['id']] != null) ...[
                    IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => _remove(i)),
                    Text('${_cart[i['id']]!.qty}'),
                  ],
                  IconButton(icon: const Icon(Icons.add_circle), onPressed: () => _add(i)),
                ]),
              ),
            ),
        ],
      ]),
    );
  }
}
