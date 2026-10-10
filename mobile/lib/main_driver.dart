import 'package:flutter/material.dart';

import 'src/app.dart';
import 'src/config.dart';

void main() {
  AppConfig.assertSecure();
  runApp(const UberMartApp(mode: AppMode.driver));
}
