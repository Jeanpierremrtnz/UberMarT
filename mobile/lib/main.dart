import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/config.dart';

/// Punto de entrada por defecto (app del pasajero).
void main() {
  AppConfig.assertSecure();
  runApp(const UberMartApp(mode: AppMode.passenger));
}
