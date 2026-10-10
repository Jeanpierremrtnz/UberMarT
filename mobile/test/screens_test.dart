import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:ubermart/src/config.dart';
import 'package:ubermart/src/core/api_client.dart';
import 'package:ubermart/src/core/realtime.dart';
import 'package:ubermart/src/core/services.dart';
import 'package:ubermart/src/core/session.dart';
import 'package:ubermart/src/food/menu_screen.dart';
import 'package:ubermart/src/food/merchants_screen.dart';
import 'package:ubermart/src/food/order_screen.dart';
import 'package:ubermart/src/passenger/parcel_form.dart';

// Token con vencimiento lejano para que el cliente no intente renovarlo.
final _jwt = 'x.${base64Url.encode(utf8.encode('{"exp":4102444800}')).replaceAll('=', '')}.y';

Future<Widget> _app(Widget child, Map<String, Object> routes) async {
  FlutterSecureStorage.setMockInitialValues({'access': _jwt, 'refresh': 'r' * 40, 'device': 'd-test-device-01'});
  final session = Session();
  await session.load();
  final client = MockClient((req) async {
    final body = routes['${req.method} ${req.url.path}'];
    if (body == null) return http.Response('{"error":{"code":"NOT_FOUND","message":"No encontrado"}}', 404);
    return http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});
  });
  final api = ApiClient(session, client: client);
  return Services(
    mode: AppMode.passenger,
    session: session,
    api: api,
    realtime: Realtime(api),
    child: MaterialApp(home: child),
  );
}

const _merchantId = '11111111-1111-4111-8111-111111111111';

void main() {
  testWidgets('lista de locales: abiertos y cerrados', (tester) async {
    await tester.pumpWidget(await _app(const MerchantsScreen(), {
      'GET /api/merchants': [
        {'id': _merchantId, 'name': 'Encebollados Don Pepe', 'category': 'restaurante', 'distanceM': 1200, 'isOpen': true, 'scheduleText': null},
        {'id': '2', 'name': 'Café del Puerto', 'category': 'cafeteria', 'distanceM': 3400, 'isOpen': false, 'scheduleText': 'Lun-Vie'},
      ],
    }));
    await tester.pumpAndSettle();
    expect(find.text('Encebollados Don Pepe'), findsOneWidget);
    expect(find.textContaining('Cerrado'), findsOneWidget);
    expect(find.textContaining('1.2 km'), findsOneWidget);
  });

  testWidgets('menú: agregar productos actualiza el carrito', (tester) async {
    await tester.pumpWidget(await _app(const MenuScreen(merchantId: _merchantId), {
      'GET /api/merchants/$_merchantId': {
        'id': _merchantId,
        'name': 'Encebollados Don Pepe',
        'addressLabel': 'Centro de Manta',
        'scheduleText': null,
        'prepMinutes': 15,
        'items': [
          {'id': 'a', 'category': 'Platos', 'name': 'Encebollado', 'description': null, 'priceCents': 350, 'photoUrl': null},
          {'id': 'b', 'category': 'Bebidas', 'name': 'Jugo', 'description': 'Natural', 'priceCents': 125, 'photoUrl': null},
        ],
      },
    }));
    await tester.pumpAndSettle();
    expect(find.text('Platos'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.add_circle).first);
    await tester.tap(find.byIcon(Icons.add_circle).first);
    await tester.tap(find.byIcon(Icons.add_circle).last);
    await tester.pump();
    expect(find.text('Ver pedido · 3 productos · \$8.25'), findsOneWidget);
  });

  testWidgets('pedido: muestra estado, motorizado y PIN de entrega', (tester) async {
    await tester.pumpWidget(await _app(const OrderScreen(orderId: 'o1'), {
      'GET /api/orders/o1': {
        'id': 'o1',
        'code': 'ZMERAA',
        'status': 'picked_up',
        'statusReason': null,
        'merchant': {'id': _merchantId, 'name': 'Encebollados Don Pepe', 'phone': '+593991112233'},
        'items': [
          {'name': 'Encebollado', 'qty': 2, 'note': 'bien caliente', 'priceCents': 350},
        ],
        'subtotalCents': 700,
        'deliveryFeeCents': 150,
        'totalCents': 850,
        'tripId': 't1',
        'deliveryPin': '4821',
        'driver': {'firstName': 'Carlos', 'plate': 'MA123B', 'moto': 'Honda XR150 Rojo'},
      },
    }));
    await tester.pumpAndSettle();
    expect(find.text('Pedido #ZMERAA'), findsOneWidget);
    expect(find.text('4821'), findsOneWidget);
    expect(find.text('Carlos · MA123B'), findsOneWidget);
    expect(find.textContaining('\$8.50'), findsOneWidget);
    expect(find.text('Cancelar pedido'), findsNothing);
  });

  testWidgets('envío: el formulario exige declarar que no hay artículos prohibidos', (tester) async {
    Map<String, dynamic>? result;
    await tester.pumpWidget(await _app(
      Scaffold(body: Builder(builder: (context) => TextButton(onPressed: () async => result = await showParcelForm(context), child: const Text('abrir')))),
      {},
    ));
    await tester.tap(find.text('abrir'));
    await tester.pumpAndSettle();
    final fields = find.byType(TextFormField);
    await tester.enterText(fields.at(0), 'Pedro Cedeño');
    await tester.enterText(fields.at(1), '0998887766');
    await tester.enterText(fields.at(2), 'Documentos');
    await tester.tap(find.text('Continuar'));
    await tester.pumpAndSettle();
    expect(result, isNull);
    await tester.tap(find.byType(Checkbox));
    await tester.tap(find.text('Continuar'));
    await tester.pumpAndSettle();
    expect(result?['recipientPhone'], '0998887766');
    expect(result?['prohibitedItemsAck'], isTrue);
    expect(result?['payer'], 'sender');
  });
}
