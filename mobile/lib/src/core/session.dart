import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Tokens y deviceId guardados en el almacenamiento seguro del sistema
/// (Keychain en iOS, Keystore en Android). Nunca en SharedPreferences.
class Session extends ChangeNotifier {
  Session([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  String? accessToken;
  String? refreshToken;
  late String deviceId;

  bool get isLoggedIn => refreshToken != null;

  Future<void> load() async {
    accessToken = await _storage.read(key: 'access');
    refreshToken = await _storage.read(key: 'refresh');
    final existing = await _storage.read(key: 'device');
    if (existing != null) {
      deviceId = existing;
    } else {
      final rnd = Random.secure();
      deviceId = 'd-${List.generate(24, (_) => rnd.nextInt(16).toRadixString(16)).join()}';
      await _storage.write(key: 'device', value: deviceId);
    }
  }

  Future<void> save({required String access, required String refresh}) async {
    accessToken = access;
    refreshToken = refresh;
    await _storage.write(key: 'access', value: access);
    await _storage.write(key: 'refresh', value: refresh);
    notifyListeners();
  }

  Future<void> clear() async {
    accessToken = null;
    refreshToken = null;
    await _storage.delete(key: 'access');
    await _storage.delete(key: 'refresh');
    notifyListeners();
  }
}
