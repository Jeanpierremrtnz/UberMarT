import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/services.dart';
import 'wallet_screen.dart' show pickPhoto;

const _documents = {
  'cedula_front': 'Cédula (frente)',
  'cedula_back': 'Cédula (reverso)',
  'license_front': 'Licencia tipo A (frente)',
  'license_back': 'Licencia tipo A (reverso)',
  'vehicle_registration': 'Matrícula de la moto',
  'criminal_record': 'Certificado de antecedentes penales',
  'selfie': 'Selfie (rostro visible, sin casco ni lentes)',
  'moto_photo': 'Foto de la moto con la placa visible',
};

/// Registro del conductor (KYC): datos de la moto, licencia y documentos.
class RegistrationScreen extends StatefulWidget {
  const RegistrationScreen({super.key});

  @override
  State<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends State<RegistrationScreen> {
  final _form = GlobalKey<FormState>();
  final _license = TextEditingController();
  final _plate = TextEditingController();
  final _brand = TextEditingController();
  final _model = TextEditingController();
  final _year = TextEditingController();
  final _color = TextEditingController();
  DateTime? _expires;
  Map<String, bool> _uploaded = {};
  bool _saved = false;
  bool _busy = false;
  String? _note;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_uploaded.isEmpty) _load();
  }

  @override
  void dispose() {
    for (final c in [_license, _plate, _brand, _model, _year, _color]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final app = await Services.of(context).api.get('/api/driver/application');
    if (!mounted || app['status'] == 'none') return;
    final moto = app['moto'] as Map;
    setState(() {
      _saved = true;
      _note = app['note'] as String?;
      _plate.text = (app['plate'] ?? '') as String;
      _brand.text = (moto['brand'] ?? '') as String;
      _model.text = (moto['model'] ?? '') as String;
      _year.text = moto['year']?.toString() ?? '';
      _color.text = (moto['color'] ?? '') as String;
      _expires = app['licenseExpiresOn'] != null ? DateTime.tryParse(app['licenseExpiresOn'] as String) : null;
      _uploaded = {for (final d in app['documents'] as List) d['kind'] as String: d['uploaded'] as bool};
    });
  }

  Future<void> _saveData() async {
    if (!_form.currentState!.validate() || _expires == null) {
      showMessage(context, 'Completa todos los datos y la fecha de vencimiento de la licencia');
      return;
    }
    setState(() => _busy = true);
    try {
      final e = _expires!;
      await Services.of(context).api.put('/api/driver/application', {
        'licenseNumber': _license.text.trim(),
        'licenseExpiresOn': '${e.year.toString().padLeft(4, '0')}-${e.month.toString().padLeft(2, '0')}-${e.day.toString().padLeft(2, '0')}',
        'plate': _plate.text.trim(),
        'motoBrand': _brand.text.trim(),
        'motoModel': _model.text.trim(),
        'motoYear': int.parse(_year.text),
        'motoColor': _color.text.trim(),
      });
      setState(() => _saved = true);
      if (mounted) showMessage(context, 'Datos guardados. Ahora sube tus documentos.');
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _upload(String kind) async {
    final photo = await pickPhoto(context, cameraOnly: kind == 'selfie');
    if (photo == null || !mounted) return;
    setState(() => _busy = true);
    try {
      await Services.of(context).api.upload('PUT', '/api/driver/documents/$kind', fields: {}, fileField: 'file', bytes: photo);
      setState(() => _uploaded[kind] = true);
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submit() async {
    setState(() => _busy = true);
    try {
      await Services.of(context).api.post('/api/driver/application/submit');
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final allUploaded = _documents.keys.every((k) => _uploaded[k] == true);
    String? required(String? v) => (v ?? '').trim().isEmpty ? 'Obligatorio' : null;
    return Scaffold(
      appBar: AppBar(title: const Text('Registro de conductor')),
      body: Form(
        key: _form,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          if (_note != null) Card(child: ListTile(leading: const Icon(Icons.info), title: Text(_note!))),
          Text('1. Tu moto y licencia', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          TextFormField(controller: _license, decoration: const InputDecoration(labelText: 'Número de licencia'), validator: required),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            icon: const Icon(Icons.event),
            label: Text(_expires == null ? 'Fecha de vencimiento de la licencia' : 'Licencia vence: ${_expires!.toLocal().toString().split(' ').first}'),
            onPressed: () async {
              final now = DateTime.now();
              final d = await showDatePicker(context: context, firstDate: now, lastDate: DateTime(now.year + 10), initialDate: _expires ?? now);
              if (d != null) setState(() => _expires = d);
            },
          ),
          const SizedBox(height: 8),
          TextFormField(
            controller: _plate,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Placa', hintText: 'AB123C'),
            validator: required,
          ),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: TextFormField(controller: _brand, decoration: const InputDecoration(labelText: 'Marca'), validator: required)),
            const SizedBox(width: 8),
            Expanded(child: TextFormField(controller: _model, decoration: const InputDecoration(labelText: 'Modelo'), validator: required)),
          ]),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: TextFormField(
                controller: _year,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(4)],
                decoration: const InputDecoration(labelText: 'Año'),
                validator: (v) => (int.tryParse(v ?? '') ?? 0) < 1990 ? 'Año inválido' : null,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(child: TextFormField(controller: _color, decoration: const InputDecoration(labelText: 'Color'), validator: required)),
          ]),
          const SizedBox(height: 8),
          FilledButton.tonal(onPressed: _busy ? null : _saveData, child: const Text('Guardar datos')),
          const SizedBox(height: 24),
          Text('2. Documentos', style: Theme.of(context).textTheme.titleMedium),
          const Text('Fotos nítidas, completas y sin reflejos. Se guardan cifradas y solo las ve el equipo de verificación.'),
          for (final e in _documents.entries)
            ListTile(
              enabled: _saved && !_busy,
              leading: Icon(_uploaded[e.key] == true ? Icons.check_circle : Icons.upload_file,
                  color: _uploaded[e.key] == true ? Colors.green : null),
              title: Text(e.value),
              onTap: () => _upload(e.key),
            ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _busy || !allUploaded ? null : _submit, child: const Text('Enviar a revisión')),
        ]),
      ),
    );
  }
}
