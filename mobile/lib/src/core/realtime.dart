import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

import '../config.dart';
import 'api_client.dart';

class RealtimeEvent {
  RealtimeEvent(this.name, this.data);
  final String name;
  final dynamic data;
}

/// Canal WebSocket (Socket.io) con el servidor. Solo transporte WebSocket.
class Realtime {
  Realtime(this.api);

  final ApiClient api;
  io.Socket? _socket;
  final _events = StreamController<RealtimeEvent>.broadcast();

  Stream<RealtimeEvent> get events => _events.stream;
  bool get connected => _socket?.connected ?? false;

  static const _forwarded = [
    'trip:offer',
    'trip:offer_closed',
    'trip:update',
    'trip:searching',
    'dloc',
    'wallet:update',
    'topup:update',
    'driver:status',
  ];

  void connect() {
    if (_socket != null) return;
    final socket = io.io(
      AppConfig.apiBaseUrl,
      io.OptionBuilder()
          .setPath('/ws')
          .setTransports(['websocket'])
          .disableAutoConnect()
          .enableReconnection()
          .setReconnectionDelay(1000)
          .setReconnectionDelayMax(10000)
          .setAuthFn((callback) {
            api.validAccessToken().then((token) => callback({'token': token ?? ''})).catchError((_) => callback({'token': ''}));
          })
          .build(),
    );
    for (final name in _forwarded) {
      socket.on(name, (data) => _events.add(RealtimeEvent(name, data)));
    }
    socket.onConnect((_) => _events.add(RealtimeEvent('connected', null)));
    socket.onDisconnect((reason) {
      _events.add(RealtimeEvent('disconnected', reason));
      // El servidor cierra la conexión cuando vence el token: reconectar con uno nuevo.
      if (reason == 'io server disconnect') {
        Future.delayed(const Duration(seconds: 1), () => _socket?.connect());
      }
    });
    _socket = socket..connect();
  }

  /// Paquete ultraligero: [latE5, lngE5, rumbo, km/h, gpsSimulado].
  void sendLocation(List<int> packet) => _socket?.emit('loc', packet);

  Future<bool> watchTrip(String tripId) {
    final socket = _socket;
    if (socket == null || !socket.connected) return Future.value(false);
    final done = Completer<bool>();
    socket.emitWithAck('trip:watch', {'tripId': tripId}, ack: (data) {
      if (!done.isCompleted) done.complete(data is Map && data['ok'] == true);
    });
    return done.future.timeout(const Duration(seconds: 5), onTimeout: () => false);
  }

  void disconnect() {
    _socket?.dispose();
    _socket = null;
  }
}
