import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/validators.dart';

/// Datos del envío (mensajería). Devuelve el mapa listo para la API o null.
Future<Map<String, dynamic>?> showParcelForm(BuildContext context, {Map<String, dynamic>? initial}) {
  return showModalBottomSheet<Map<String, dynamic>>(
    context: context,
    isScrollControlled: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _ParcelForm(initial: initial),
    ),
  );
}

class _ParcelForm extends StatefulWidget {
  const _ParcelForm({this.initial});

  final Map<String, dynamic>? initial;

  @override
  State<_ParcelForm> createState() => _ParcelFormState();
}

class _ParcelFormState extends State<_ParcelForm> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.initial?['recipientName'] as String?);
  late final _phone = TextEditingController(text: widget.initial?['recipientPhone'] as String?);
  late final _description = TextEditingController(text: widget.initial?['description'] as String?);
  late final _weight = TextEditingController(text: (widget.initial?['weightKg'] ?? 1).toString());
  late final _value = TextEditingController(
    text: widget.initial?['declaredValueCents'] != null ? ((widget.initial!['declaredValueCents'] as int) / 100).toStringAsFixed(2) : '',
  );
  late String _size = (widget.initial?['size'] as String?) ?? 'pequeno';
  late String _payer = (widget.initial?['payer'] as String?) ?? 'sender';
  bool _ack = false;

  @override
  void dispose() {
    for (final c in [_name, _phone, _description, _weight, _value]) {
      c.dispose();
    }
    super.dispose();
  }

  void _submit() {
    if (!_form.currentState!.validate()) return;
    if (!_ack) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Confirma que el envío no contiene artículos prohibidos')));
      return;
    }
    Navigator.of(context).pop({
      'recipientName': _name.text.trim(),
      'recipientPhone': _phone.text.trim(),
      'description': _description.text.trim(),
      'size': _size,
      'weightKg': double.parse(_weight.text.replaceAll(',', '.')),
      'declaredValueCents': _value.text.trim().isEmpty ? 0 : parseMoneyToCents(_value.text) ?? 0,
      'payer': _payer,
      'prohibitedItemsAck': true,
    });
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Form(
        key: _form,
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(20),
          children: [
            Text('Datos del envío', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 12),
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(labelText: 'Nombre de quien recibe'),
              validator: (v) => (v ?? '').trim().length < 2 ? 'Obligatorio' : null,
            ),
            const SizedBox(height: 8),
            TextFormField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Celular de quien recibe', helperText: 'Le enviaremos el seguimiento y el PIN de entrega'),
              validator: (v) => isValidEcMobile(v ?? '') ? null : 'Celular inválido',
            ),
            const SizedBox(height: 8),
            TextFormField(
              controller: _description,
              decoration: const InputDecoration(labelText: '¿Qué envías?', hintText: 'Documentos, ropa, llaves…'),
              validator: (v) => (v ?? '').trim().length < 3 ? 'Describe el contenido' : null,
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'sobre', label: Text('Sobre')),
                ButtonSegment(value: 'pequeno', label: Text('Pequeño')),
                ButtonSegment(value: 'mediano', label: Text('Mediano')),
              ],
              selected: {_size},
              onSelectionChanged: (s) => setState(() => _size = s.first),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(
                child: TextFormField(
                  controller: _weight,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                  decoration: const InputDecoration(labelText: 'Peso aprox. (kg)'),
                  validator: (v) {
                    final w = double.tryParse((v ?? '').replaceAll(',', '.'));
                    return w == null || w <= 0 ? 'Peso inválido' : null;
                  },
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: TextFormField(
                  controller: _value,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Valor declarado (USD)', hintText: 'Opcional'),
                ),
              ),
            ]),
            const SizedBox(height: 8),
            const Text('¿Quién paga el envío en efectivo?'),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'sender', label: Text('Yo, al entregar el paquete')),
                ButtonSegment(value: 'recipient', label: Text('Quien recibe')),
              ],
              selected: {_payer},
              onSelectionChanged: (s) => setState(() => _payer = s.first),
            ),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _ack,
              onChanged: (v) => setState(() => _ack = v ?? false),
              title: const Text(
                'Declaro que el envío no contiene dinero en efectivo, armas, drogas, animales ni artículos ilegales o peligrosos. '
                'El motorizado tomará una foto del paquete.',
                style: TextStyle(fontSize: 12),
              ),
            ),
            FilledButton(onPressed: _submit, child: const Text('Continuar')),
          ],
        ),
      ),
    );
  }
}
