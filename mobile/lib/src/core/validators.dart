/// Validación local (rápida) de cédula ecuatoriana; el servidor vuelve a validar.
bool isValidCedula(String value) {
  final c = value.trim();
  if (!RegExp(r'^[0-9]{10}$').hasMatch(c)) return false;
  final province = int.parse(c.substring(0, 2));
  if (!((province >= 1 && province <= 24) || province == 30)) return false;
  if (int.parse(c[2]) >= 6) return false;
  var sum = 0;
  for (var i = 0; i < 9; i++) {
    var n = int.parse(c[i]) * (i.isEven ? 2 : 1);
    if (n > 9) n -= 9;
    sum += n;
  }
  return (10 - sum % 10) % 10 == int.parse(c[9]);
}

/// Celular ecuatoriano: 09XXXXXXXX.
bool isValidEcMobile(String value) =>
    RegExp(r'^(\+?593|0)?9[0-9]{8}$').hasMatch(value.replaceAll(RegExp(r'[\s\-()]'), ''));

/// "10", "10.5", "10,50" -> 1050 centavos. Null si no es válido.
int? parseMoneyToCents(String value) {
  final s = value.trim().replaceAll(',', '.');
  if (!RegExp(r'^\d{1,4}(\.\d{1,2})?$').hasMatch(s)) return null;
  final parts = s.split('.');
  final cents = int.parse(parts[0]) * 100 + (parts.length > 1 ? int.parse(parts[1].padRight(2, '0')) : 0);
  return cents > 0 ? cents : null;
}

String formatCents(int cents) => '\$${(cents / 100).toStringAsFixed(2)}';
