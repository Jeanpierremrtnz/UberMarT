import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/services.dart';
import '../core/validators.dart';

const banks = {
  'pichincha': 'Banco Pichincha',
  'deuna': 'Deuna',
  'guayaquil': 'Banco Guayaquil',
  'pacifico': 'Banco del Pacífico',
  'produbanco': 'Produbanco',
  'bolivariano': 'Banco Bolivariano',
  'internacional': 'Banco Internacional',
  'jep': 'Cooperativa JEP',
  'otro': 'Otro',
};

const _statusText = {'pending': 'En revisión', 'approved': 'Acreditada', 'rejected': 'Rechazada', 'cancelled': 'Cancelada'};
const _reasonText = {
  'duplicado': 'Comprobante duplicado',
  'ilegible': 'La foto no se lee bien',
  'monto_incorrecto': 'El monto no coincide',
  'referencia_incorrecta': 'La referencia no coincide',
  'no_acreditado': 'El dinero no llegó a la cuenta',
  'fraude': 'Comprobante no válido',
};

Future<Uint8List?> pickPhoto(BuildContext context, {bool cameraOnly = false}) async {
  final source = cameraOnly
      ? ImageSource.camera
      : await showModalBottomSheet<ImageSource>(
          context: context,
          builder: (c) => SafeArea(
            child: Wrap(children: [
              ListTile(leading: const Icon(Icons.photo_camera), title: const Text('Tomar foto'), onTap: () => Navigator.pop(c, ImageSource.camera)),
              ListTile(leading: const Icon(Icons.photo_library), title: const Text('Elegir captura de pantalla'), onTap: () => Navigator.pop(c, ImageSource.gallery)),
            ]),
          ),
        );
  if (source == null) return null;
  final file = await ImagePicker().pickImage(source: source, maxWidth: 1800, maxHeight: 1800, imageQuality: 85);
  return file?.readAsBytes();
}

/// Billetera del conductor: saldo, recarga por transferencia (con campos
/// obligatorios y verificación instantánea de duplicados) o con tarjeta (Payphone).
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  Map<String, dynamic>? _wallet;
  List<Map<String, dynamic>> _topups = [];
  final _form = GlobalKey<FormState>();
  final _reference = TextEditingController();
  final _amount = TextEditingController();
  String? _bank;
  Uint8List? _photo;
  bool? _referenceAvailable;
  Timer? _debounce;
  bool _busy = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_wallet == null) _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _reference.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = Services.of(context).api;
    try {
      final wallet = Map<String, dynamic>.from(await api.get('/api/wallet') as Map);
      final topups = (await api.get('/api/wallet/topups') as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
      if (!mounted) return;
      setState(() {
        _wallet = wallet;
        _topups = topups;
      });
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  /// Verificación instantánea: ¿esta referencia ya fue registrada por alguien?
  void _onReferenceChanged(String value) {
    _debounce?.cancel();
    setState(() => _referenceAvailable = null);
    if (value.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').length < 4) return;
    final api = Services.of(context).api;
    _debounce = Timer(const Duration(milliseconds: 600), () async {
      try {
        final res = await api.get('/api/wallet/topups/check-reference', query: {'reference': value});
        if (mounted && _reference.text == value) setState(() => _referenceAvailable = res['available'] == true);
      } catch (_) {}
    });
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    if (_photo == null) {
      showMessage(context, 'Adjunta la foto o captura del comprobante');
      return;
    }
    if (_referenceAvailable == false) {
      showMessage(context, 'Esa referencia ya fue registrada');
      return;
    }
    setState(() => _busy = true);
    try {
      await Services.of(context).api.upload('POST', '/api/wallet/topups',
          fields: {'bank': _bank!, 'reference': _reference.text.trim(), 'amountCents': '${parseMoneyToCents(_amount.text)}'},
          fileField: 'receipt',
          bytes: _photo);
      _reference.clear();
      _amount.clear();
      setState(() {
        _photo = null;
        _bank = null;
        _referenceAvailable = null;
      });
      if (mounted) showMessage(context, 'Recarga enviada. Se acreditará al ser verificada.');
      await _load();
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _payWithCard() async {
    final controller = TextEditingController();
    final cents = await showDialog<int>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Recargar con tarjeta o Payphone'),
        content: TextField(
          controller: controller,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(labelText: 'Monto (USD)', prefixText: '\$ '),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(c, parseMoneyToCents(controller.text)), child: const Text('Continuar')),
        ],
      ),
    );
    controller.dispose();
    if (cents == null || !mounted) return;
    try {
      final res = await Services.of(context).api.post('/api/wallet/topups/payphone', {'amountCents': cents});
      await launchUrl(Uri.parse(res['payWithCardUrl'] as String), mode: LaunchMode.externalApplication);
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  Future<void> _resubmit(Map<String, dynamic> t) async {
    final photo = await pickPhoto(context);
    if (photo == null || !mounted) return;
    try {
      await Services.of(context).api.upload('POST', '/api/wallet/topups/${t['id']}/resubmit', fields: {}, fileField: 'receipt', bytes: photo);
      await _load();
    } catch (e) {
      if (mounted) showMessage(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final w = _wallet;
    return Scaffold(
      appBar: AppBar(title: const Text('Billetera')),
      body: w == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.all(16), children: [
                Card(
                  child: ListTile(
                    title: Text(formatCents(w['balanceCents'] as int), style: Theme.of(context).textTheme.headlineMedium),
                    subtitle: Text('Comisión por viaje: ${w['commissionPercent']}% · Saldo mínimo: ${formatCents(w['minBalanceCents'] as int)}'),
                  ),
                ),
                const SizedBox(height: 8),
                FilledButton.tonalIcon(onPressed: _payWithCard, icon: const Icon(Icons.credit_card), label: const Text('Recargar al instante con tarjeta / Payphone')),
                const SizedBox(height: 24),
                Text('Recarga por transferencia o Deuna', style: Theme.of(context).textTheme.titleMedium),
                for (final a in (w['topupAccounts'] as List? ?? const []))
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.account_balance),
                    title: Text('${a['bank']} · ${a['accountType']} ${a['number']}'),
                    subtitle: Text('${a['holder']} · ${a['idNumber']}'),
                  ),
                Form(
                  key: _form,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    const SizedBox(height: 8),
                    DropdownButtonFormField<String>(
                      initialValue: _bank,
                      decoration: const InputDecoration(labelText: 'Banco o billetera desde donde pagaste'),
                      items: [for (final e in banks.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
                      onChanged: (v) => setState(() => _bank = v),
                      validator: (v) => v == null ? 'Selecciona el banco' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _reference,
                      onChanged: _onReferenceChanged,
                      decoration: InputDecoration(
                        labelText: 'Número de referencia / secuencial / comprobante',
                        helperText: 'Cópialo exactamente como aparece en tu comprobante',
                        suffixIcon: _referenceAvailable == null
                            ? null
                            : Icon(_referenceAvailable! ? Icons.check_circle : Icons.error, color: _referenceAvailable! ? Colors.green : Colors.red),
                        errorText: _referenceAvailable == false ? 'Esta referencia ya fue registrada' : null,
                      ),
                      validator: (v) =>
                          (v ?? '').replaceAll(RegExp(r'[^A-Za-z0-9]'), '').length < 4 ? 'La referencia es obligatoria' : null,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _amount,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: 'Monto exacto transferido', prefixText: '\$ '),
                      validator: (v) => parseMoneyToCents(v ?? '') == null ? 'Escribe el monto exacto, ej. 10.00' : null,
                    ),
                    const SizedBox(height: 12),
                    OutlinedButton.icon(
                      onPressed: () async {
                        final p = await pickPhoto(context);
                        if (p != null) setState(() => _photo = p);
                      },
                      icon: Icon(_photo == null ? Icons.add_a_photo : Icons.check),
                      label: Text(_photo == null ? 'Adjuntar foto del comprobante' : 'Comprobante adjunto (cambiar)'),
                    ),
                    if (_photo != null) Padding(padding: const EdgeInsets.only(top: 8), child: Image.memory(_photo!, height: 160)),
                    const SizedBox(height: 12),
                    FilledButton(onPressed: _busy ? null : _submit, child: const Text('Enviar recarga')),
                  ]),
                ),
                const SizedBox(height: 24),
                Text('Historial', style: Theme.of(context).textTheme.titleMedium),
                for (final t in _topups)
                  ListTile(
                    title: Text('${formatCents(t['amountCents'] as int)} · ${_statusText[t['status']] ?? t['status']}'),
                    subtitle: Text([
                      if (t['reference'] != null) 'Ref. ${t['reference']}',
                      if (t['rejectReason'] != null) _reasonText[t['rejectReason']] ?? '',
                      if (t['rejectNote'] != null) t['rejectNote'],
                    ].join(' · ')),
                    trailing: t['canResubmit'] == true ? TextButton(onPressed: () => _resubmit(t), child: const Text('Reenviar')) : null,
                  ),
              ]),
            ),
    );
  }
}
