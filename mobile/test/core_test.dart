import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';
import 'package:ubermart/src/core/geo.dart';
import 'package:ubermart/src/core/location_throttle.dart';
import 'package:ubermart/src/core/validators.dart';

void main() {
  group('LocationThrottle (5-8 s o 15 m)', () {
    final start = DateTime(2026, 10, 12, 7, 30);
    const base = LatLng(-0.9500, -80.7300);
    LatLng north(double meters) => LatLng(base.latitude + meters / 111320, base.longitude);

    test('envía el primer punto', () {
      expect(LocationThrottle().shouldSend(base, start), isTrue);
    });

    test('detenido en un semáforo no envía datos repetidos', () {
      final t = LocationThrottle()..shouldSend(base, start);
      for (var s = 1; s <= 60; s++) {
        expect(t.shouldSend(north(1), start.add(Duration(seconds: s))), isFalse, reason: 'segundo $s');
      }
    });

    test('envía si se movió más de 15 m (respetando el mínimo de 3 s)', () {
      final t = LocationThrottle()..shouldSend(base, start);
      expect(t.shouldSend(north(20), start.add(const Duration(seconds: 1))), isFalse);
      expect(t.shouldSend(north(20), start.add(const Duration(seconds: 3))), isTrue);
    });

    test('a baja velocidad envía cada ~6 s si hubo movimiento real', () {
      final t = LocationThrottle()..shouldSend(base, start);
      expect(t.shouldSend(north(8), start.add(const Duration(seconds: 4))), isFalse);
      expect(t.shouldSend(north(8), start.add(const Duration(seconds: 6))), isTrue);
    });

    test('reset fuerza el siguiente envío', () {
      final t = LocationThrottle()..shouldSend(base, start);
      t.reset();
      expect(t.shouldSend(base, start.add(const Duration(milliseconds: 10))), isTrue);
    });
  });

  test('polilínea de OSRM se decodifica', () {
    final pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts.length, 3);
    expect(pts.first.latitude, closeTo(38.5, 1e-5));
    expect(pts.last.longitude, closeTo(-126.453, 1e-5));
  });

  test('coordenadas compactas E5', () {
    expect(toE5(-0.950213), -95021);
    expect(fromE5(-8073120), closeTo(-80.7312, 1e-9));
  });

  test('validaciones de Ecuador', () {
    expect(isValidCedula('1710034065'), isTrue);
    expect(isValidCedula('1710034066'), isFalse);
    expect(isValidEcMobile('0991234567'), isTrue);
    expect(isValidEcMobile('022345678'), isFalse);
    expect(parseMoneyToCents('10'), 1000);
    expect(parseMoneyToCents('10,5'), 1050);
    expect(parseMoneyToCents('0'), isNull);
    expect(parseMoneyToCents('abc'), isNull);
    expect(formatCents(225), '\$2.25');
  });
}
