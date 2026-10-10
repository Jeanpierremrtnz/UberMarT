import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config.dart';
import '../core/services.dart';
import '../core/validators.dart';

/// Ingreso sin contraseña: celular ecuatoriano + código SMS de 6 dígitos.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  String? _challengeId;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _requestCode() async {
    if (!isValidEcMobile(_phone.text)) {
      showMessage(context, 'Ingresa tu celular, ej. 0991234567');
      return;
    }
    setState(() => _busy = true);
    try {
      final res = await Services.of(context).api.post('/api/auth/otp/request', {'phone': _phone.text});
      setState(() => _challengeId = res['challengeId'] as String);
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final services = Services.of(context);
    setState(() => _busy = true);
    try {
      final res = await services.api.post('/api/auth/otp/verify', {
        'challengeId': _challengeId,
        'code': _code.text.trim(),
        'deviceId': services.session.deviceId,
      });
      await services.session.save(access: res['accessToken'] as String, refresh: res['refreshToken'] as String);
    } catch (e) {
      if (mounted) showMessage(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDriver = Services.of(context).mode == AppMode.driver;
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const SizedBox(height: 40),
            Text(isDriver ? 'UberMarT Conductor' : 'UberMarT', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 8),
            Text(isDriver ? 'Genera ingresos con tu moto en Manta.' : 'Muévete rápido y seguro por Manta.'),
            const SizedBox(height: 32),
            TextField(
              controller: _phone,
              enabled: _challengeId == null,
              keyboardType: TextInputType.phone,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+ ]')), LengthLimitingTextInputFormatter(14)],
              decoration: const InputDecoration(labelText: 'Celular', hintText: '0991234567'),
            ),
            if (_challengeId != null) ...[
              const SizedBox(height: 16),
              TextField(
                controller: _code,
                keyboardType: TextInputType.number,
                autofillHints: const [AutofillHints.oneTimeCode],
                inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                decoration: const InputDecoration(labelText: 'Código recibido por SMS'),
              ),
              TextButton(
                onPressed: _busy ? null : () => setState(() => _challengeId = null),
                child: const Text('Cambiar número'),
              ),
            ],
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _busy ? null : (_challengeId == null ? _requestCode : _verify),
              child: Text(_challengeId == null ? 'Recibir código' : 'Ingresar'),
            ),
            const SizedBox(height: 16),
            const Text('Nunca te pediremos este código por llamada ni WhatsApp.', style: TextStyle(fontSize: 12)),
          ],
        ),
      ),
    );
  }
}
