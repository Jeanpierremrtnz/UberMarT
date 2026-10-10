import 'package:flutter/material.dart';

import '../config.dart';
import 'api_client.dart';
import 'realtime.dart';
import 'session.dart';

/// Acceso a los servicios compartidos desde cualquier pantalla.
class Services extends InheritedWidget {
  const Services({
    super.key,
    required this.mode,
    required this.session,
    required this.api,
    required this.realtime,
    required super.child,
  });

  final AppMode mode;
  final Session session;
  final ApiClient api;
  final Realtime realtime;

  static Services of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<Services>()!;

  @override
  bool updateShouldNotify(Services oldWidget) => false;
}

void showMessage(BuildContext context, Object error) {
  final text = error is ApiException ? error.message : error.toString();
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(text)));
}
