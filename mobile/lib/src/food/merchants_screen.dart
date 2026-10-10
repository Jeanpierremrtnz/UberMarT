import 'package:flutter/material.dart';

import '../config.dart';
import '../core/services.dart';
import '../widgets/common.dart';
import 'menu_screen.dart';

const categoryNames = {
  'restaurante': 'Restaurante',
  'comida_rapida': 'Comida rápida',
  'cafeteria': 'Cafetería',
  'panaderia': 'Panadería',
  'farmacia': 'Farmacia',
  'tienda': 'Tienda',
  'otro': 'Otro',
};

/// Locales verificados cerca del cliente (primero los abiertos).
class MerchantsScreen extends StatefulWidget {
  const MerchantsScreen({super.key});

  @override
  State<MerchantsScreen> createState() => _MerchantsScreenState();
}

class _MerchantsScreenState extends State<MerchantsScreen> {
  List<Map<String, dynamic>>? _merchants;
  String? _error;
  String _filter = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final api = Services.of(context).api;
    final pos = await currentPosition();
    final lat = pos?.latitude ?? AppConfig.mantaCenter.latitude;
    final lng = pos?.longitude ?? AppConfig.mantaCenter.longitude;
    try {
      final list = await api.get('/api/merchants', query: {'lat': '$lat', 'lng': '$lng'}) as List;
      if (mounted) setState(() => _merchants = list.map((e) => Map<String, dynamic>.from(e as Map)).toList());
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    final list = (_merchants ?? const <Map<String, dynamic>>[])
        .where((m) => _filter.isEmpty || (m['name'] as String).toLowerCase().contains(_filter.toLowerCase()))
        .toList();
    return Scaffold(
      appBar: AppBar(title: const Text('Comida y locales')),
      body: _merchants == null
          ? Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.all(12), children: [
                TextField(
                  decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Buscar local'),
                  onChanged: (v) => setState(() => _filter = v),
                ),
                const SizedBox(height: 8),
                if (list.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Text('Aún no hay locales en tu zona.', textAlign: TextAlign.center)),
                for (final m in list)
                  Card(
                    child: ListTile(
                      enabled: m['isOpen'] == true,
                      leading: CircleAvatar(child: Icon(m['category'] == 'farmacia' ? Icons.local_pharmacy : Icons.restaurant)),
                      title: Text(m['name'] as String),
                      subtitle: Text([
                        categoryNames[m['category']] ?? '',
                        '${((m['distanceM'] as int) / 1000).toStringAsFixed(1)} km',
                        if (m['isOpen'] != true) 'Cerrado',
                        if (m['scheduleText'] != null) m['scheduleText'],
                      ].join(' · ')),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: m['isOpen'] == true
                          ? () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => MenuScreen(merchantId: m['id'] as String)))
                          : null,
                    ),
                  ),
              ]),
            ),
    );
  }
}
