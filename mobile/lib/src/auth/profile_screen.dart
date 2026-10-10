import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/services.dart';
import '../core/validators.dart';

/// Registro obligatorio de identidad (nombre + cédula) antes de usar la app.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.onSaved});

  final VoidCallback onSaved;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _cedula = TextEditingController();
  final _email = TextEditingController();
  bool _accepted = false;
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _cedula.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    if (!_accepted) {
      showMessage(context, 'Debes aceptar el tratamiento de datos para continuar');
      return;
    }
    setState(() => _busy = true);
    try {
      await Services.of(context).api.put('/api/me/profile', {
        'fullName': _name.text.trim(),
        'cedula': _cedula.text.trim(),
        if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
      });
      widget.onSaved();
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tus datos')),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Text('Por la seguridad de todos, cada cuenta está vinculada a una cédula real. '
                'Tu cédula se guarda cifrada y nunca se muestra a otros usuarios.'),
            const SizedBox(height: 24),
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Nombres y apellidos'),
              validator: (v) => (v ?? '').trim().length < 5 ? 'Escribe tu nombre completo' : null,
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _cedula,
              keyboardType: TextInputType.number,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
              decoration: const InputDecoration(labelText: 'Cédula'),
              validator: (v) => isValidCedula(v ?? '') ? null : 'Cédula no válida',
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _email,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Correo (opcional)'),
            ),
            const SizedBox(height: 16),
            CheckboxListTile(
              value: _accepted,
              onChanged: (v) => setState(() => _accepted = v ?? false),
              contentPadding: EdgeInsets.zero,
              title: const Text(
                'Acepto el tratamiento de mis datos personales conforme a la Ley Orgánica de Protección de Datos Personales.',
                style: TextStyle(fontSize: 13),
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: _busy ? null : _save, child: const Text('Continuar')),
          ],
        ),
      ),
    );
  }
}
