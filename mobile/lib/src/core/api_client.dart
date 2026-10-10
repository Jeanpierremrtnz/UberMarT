import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'session.dart';

class ApiException implements Exception {
  ApiException(this.status, this.code, this.message, [this.details]);
  final int status;
  final String code;
  final String message;
  final dynamic details;

  @override
  String toString() => message;
}

/// Cliente HTTP con renovación automática y única (single-flight) del token.
class ApiClient {
  ApiClient(this.session, {http.Client? client}) : _http = client ?? http.Client();

  final Session session;
  final http.Client _http;
  Future<void>? _refreshing;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${AppConfig.apiBaseUrl}$path').replace(queryParameters: query);

  Future<dynamic> get(String path, {Map<String, String>? query}) =>
      _send(() => http.Request('GET', _uri(path, query)));

  Future<dynamic> post(String path, [Object? body]) => _send(() => _json('POST', path, body));

  Future<dynamic> put(String path, Object body) => _send(() => _json('PUT', path, body));

  Future<dynamic> delete(String path) => _send(() => http.Request('DELETE', _uri(path)));

  Future<dynamic> upload(
    String method,
    String path, {
    required Map<String, String> fields,
    required String fileField,
    Uint8List? bytes,
  }) {
    return _send(() {
      final req = http.MultipartRequest(method, _uri(path))..fields.addAll(fields);
      if (bytes != null) req.files.add(http.MultipartFile.fromBytes(fileField, bytes, filename: 'foto.jpg'));
      return req;
    }, timeout: const Duration(seconds: 60));
  }

  http.Request _json(String method, String path, Object? body) {
    final req = http.Request(method, _uri(path));
    req.headers['Content-Type'] = 'application/json';
    req.body = jsonEncode(body ?? {});
    return req;
  }

  Future<dynamic> _send(http.BaseRequest Function() build, {Duration timeout = const Duration(seconds: 15)}) async {
    await _ensureFreshToken();
    var res = await _execute(build(), timeout);
    if (res.statusCode == 401 && session.isLoggedIn) {
      await _refresh();
      res = await _execute(build(), timeout);
    }
    return _decode(res);
  }

  Future<http.Response> _execute(http.BaseRequest req, Duration timeout) async {
    final token = session.accessToken;
    if (token != null) req.headers['Authorization'] = 'Bearer $token';
    req.headers['Accept'] = 'application/json';
    try {
      return await http.Response.fromStream(await _http.send(req).timeout(timeout));
    } on TimeoutException {
      throw ApiException(0, 'TIMEOUT', 'El servidor tardó demasiado. Revisa tu conexión.');
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'Sin conexión con el servidor.');
    }
  }

  dynamic _decode(http.Response res) {
    final body = res.body.isEmpty ? null : jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 200 && res.statusCode < 300) return body;
    final err = body is Map ? body['error'] : null;
    throw ApiException(
      res.statusCode,
      (err?['code'] ?? 'HTTP_${res.statusCode}') as String,
      (err?['message'] ?? 'Error ${res.statusCode}') as String,
      err?['details'],
    );
  }

  /// Token válido por al menos 60 s (lo usa también el WebSocket).
  Future<String?> validAccessToken() async {
    await _ensureFreshToken();
    return session.accessToken;
  }

  Future<void> _ensureFreshToken() async {
    final token = session.accessToken;
    if (!session.isLoggedIn) return;
    if (token == null || _expiresSoon(token)) await _refresh();
  }

  bool _expiresSoon(String jwt) {
    try {
      final payload = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(jwt.split('.')[1])))) as Map;
      final exp = DateTime.fromMillisecondsSinceEpoch((payload['exp'] as int) * 1000);
      return exp.difference(DateTime.now()) < const Duration(seconds: 60);
    } catch (_) {
      return true;
    }
  }

  Future<void> _refresh() {
    return _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);
  }

  Future<void> _doRefresh() async {
    final refresh = session.refreshToken;
    if (refresh == null) return;
    final req = _json('POST', '/api/auth/refresh', {'refreshToken': refresh, 'deviceId': session.deviceId});
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 15)));
    } catch (_) {
      throw ApiException(0, 'NETWORK', 'Sin conexión con el servidor.');
    }
    if (res.statusCode == 200) {
      final data = jsonDecode(res.body) as Map;
      await session.save(access: data['accessToken'] as String, refresh: data['refreshToken'] as String);
    } else if (res.statusCode == 401 || res.statusCode == 403) {
      await session.clear();
      throw ApiException(401, 'SESSION_ENDED', 'Tu sesión terminó. Ingresa de nuevo.');
    }
  }
}
