import 'package:flutter/material.dart';

import '../core/services.dart';
import '../core/validators.dart';

/// Contactos que recibirán un SMS con tu ubicación si activas el botón SOS.
class EmergencyContactsScreen extends StatefulWidget {
  const EmergencyContactsScreen({super.key});

  @override
  State<EmergencyContactsScreen> createState() => _EmergencyContactsScreenState();
}

class _EmergencyContactsScreenState extends State<EmergencyContactsScreen> {
  List<Map<String, dynamic>> _contacts = [];
  final _name = TextEditingController();
  final _phone = TextEditingController();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final list = await Services.of(context).api.get('/api/me/emergency-contacts') as List;
      if (mounted) setState(() => _contacts = list.map((e) => Map<String, dynamic>.from(e as Map)).toList());
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _add() async {
    if (_name.text.trim().length < 2 || !isValidEcMobile(_phone.text)) {
      showMessage(context, 'Escribe un nombre y un celular válido');
      return;
    }
    try {
      await Services.of(context).api.post('/api/me/emergency-contacts', {'name': _name.text.trim(), 'phone': _phone.text});
      _name.clear();
      _phone.clear();
      await _load();
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _remove(String id) async {
    await Services.of(context).api.delete('/api/me/emergency-contacts/$id');
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Contactos de emergencia')),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        const Text('Si activas el botón SOS les enviaremos un SMS con tu ubicación y el link para seguir tu viaje en vivo. Máximo 3.'),
        const SizedBox(height: 12),
        for (final c in _contacts)
          ListTile(
            leading: const Icon(Icons.person),
            title: Text(c['name'] as String),
            subtitle: Text(c['phone'] as String),
            trailing: IconButton(icon: const Icon(Icons.delete_outline), onPressed: () => _remove(c['id'] as String)),
          ),
        if (_contacts.length < 3) ...[
          const SizedBox(height: 12),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Nombre')),
          const SizedBox(height: 8),
          TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Celular')),
          const SizedBox(height: 8),
          FilledButton(onPressed: _add, child: const Text('Agregar contacto')),
        ],
      ]),
    );
  }
}
