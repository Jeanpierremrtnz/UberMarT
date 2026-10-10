import 'package:flutter/material.dart';

import 'auth/login_screen.dart';
import 'auth/profile_screen.dart';
import 'config.dart';
import 'core/api_client.dart';
import 'core/realtime.dart';
import 'core/services.dart';
import 'core/session.dart';
import 'driver/driver_home.dart';
import 'passenger/passenger_home.dart';

class UberMartApp extends StatefulWidget {
  const UberMartApp({super.key, required this.mode});

  final AppMode mode;

  @override
  State<UberMartApp> createState() => _UberMartAppState();
}

class _UberMartAppState extends State<UberMartApp> {
  late final Session _session = Session();
  late final ApiClient _api = ApiClient(_session);
  late final Realtime _realtime = Realtime(_api);
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _session.load().then((_) => setState(() => _loaded = true));
  }

  @override
  void dispose() {
    _realtime.disconnect();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isDriver = widget.mode == AppMode.driver;
    return Services(
      mode: widget.mode,
      session: _session,
      api: _api,
      realtime: _realtime,
      child: MaterialApp(
        title: isDriver ? 'UberMarT Conductor' : 'UberMarT',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          colorScheme: ColorScheme.fromSeed(seedColor: isDriver ? const Color(0xFF0F9D58) : const Color(0xFF1F5EFF)),
          useMaterial3: true,
          inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
        ),
        home: _loaded ? const _Root() : const Scaffold(body: Center(child: CircularProgressIndicator())),
      ),
    );
  }
}

/// Decide la primera pantalla: ingreso, perfil o inicio según el rol de la app.
class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  Future<Map<String, dynamic>>? _profile;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final services = Services.of(context);
    services.session.addListener(_onSession);
    if (services.session.isLoggedIn) _loadProfile();
  }

  void _onSession() {
    if (!mounted) return;
    final services = Services.of(context);
    if (services.session.isLoggedIn) {
      _loadProfile();
    } else {
      services.realtime.disconnect();
      setState(() => _profile = null);
    }
  }

  void _loadProfile() {
    final services = Services.of(context);
    setState(() => _profile = services.api.get('/api/me').then((v) => Map<String, dynamic>.from(v as Map)));
  }

  @override
  Widget build(BuildContext context) {
    final services = Services.of(context);
    if (!services.session.isLoggedIn) return const LoginScreen();
    return FutureBuilder<Map<String, dynamic>>(
      future: _profile,
      builder: (context, snap) {
        if (snap.hasError) {
          return Scaffold(
            body: Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(snap.error.toString(), textAlign: TextAlign.center),
                const SizedBox(height: 12),
                FilledButton(onPressed: _loadProfile, child: const Text('Reintentar')),
              ]),
            ),
          );
        }
        if (!snap.hasData) return const Scaffold(body: Center(child: CircularProgressIndicator()));
        final profile = snap.data!;
        if (profile['profileComplete'] != true) return ProfileScreen(onSaved: _loadProfile);
        services.realtime.connect();
        return services.mode == AppMode.driver ? DriverHome(profile: profile) : PassengerHome(profile: profile);
      },
    );
  }
}
