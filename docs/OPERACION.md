# Operación diaria

Panel: `https://api.tudominio.ec/admin/` (correo + contraseña + código del autenticador).

## Recargas de saldo de los conductores

Los conductores prepagan saldo; cada viaje completado descuenta la comisión
(10 % por defecto). Sin el saldo mínimo ($1,00) no pueden conectarse.

### Paso 1 — Lo que hace el conductor en la app
1. Transfiere a una de las cuentas que configuras en *Tarifas → Cuentas para transferencias*.
2. Elige el banco/billetera de origen, escribe el **número de referencia/secuencial**
   y el **monto exacto**, y adjunta la foto o captura. El formulario no se envía incompleto.
3. Mientras escribe la referencia, la app verifica al instante si ya fue registrada.

El sistema rechaza automáticamente:
- una referencia ya usada por **cualquier** conductor (aunque cambie banco, guiones o ceros a la izquierda);
- la misma imagen de comprobante subida dos veces;
- más de 3 recargas pendientes por conductor; montos fuera de $1-$200 (configurable).

### Paso 2 — Aprobación rápida en el panel
Pestaña **Recargas**: la recarga más antigua aparece primero, con la foto a la izquierda
y los datos a la derecha.

| Tecla | Acción |
|-------|--------|
| `A` | Aprobar (acredita el saldo al instante y pasa a la siguiente) |
| `R` | Rechazar → elegir motivo con `1`-`6` |
| `Esc` | Cerrar el selector de motivo |

Antes de aprobar mira la franja de color:
- **Verde** — "Confirmado en el estado de cuenta": referencia y monto coinciden con tu banco. Aprueba.
- **Amarilla** — sin confirmar: revisa tu banca o importa el estado de cuenta.
- **Roja** — la referencia llegó al banco con **otro monto**: rechaza por *Monto no coincide* o *Fraude*.

Motivos de rechazo y su efecto:

| # | Motivo | Efecto |
|---|--------|--------|
| 1 | Foto ilegible | El conductor puede reenviar otra foto (máx. 2 reenvíos) |
| 2 | Monto no coincide | Puede reenviar corrigiendo el monto |
| 3 | Referencia mal digitada | La referencia queda libre; debe crear una recarga nueva con la correcta |
| 4 | Dinero no llegó | Rechazo definitivo |
| 5 | Comprobante duplicado | Rechazo definitivo |
| 6 | Fraude | Rechazo definitivo y **suspensión inmediata** del conductor |

### Conciliación con el banco (recomendado a diario)
Exporta los movimientos de tu banca empresarial en CSV y súbelos en
*Recargas → Importar estado de cuenta*. Se detectan las columnas de referencia y
monto (Documento/Referencia/Secuencial y Crédito/Valor/Monto). Las recargas que
coincidan quedan en verde. Una captura se puede falsificar; el estado de cuenta no.

### Paso 3 — Recargas automáticas con Payphone
Con las credenciales de Payphone configuradas, el conductor toca *Recargar al instante
con tarjeta / Payphone*, paga en la página segura de Payphone y el saldo se acredita
solo, sin pasar por el panel. Configuración en Payphone Developer:
- Respuesta (response URL): `https://api.tudominio.ec/api/payments/payphone/return`
- Notificación externa (si tu cuenta la tiene): `https://api.tudominio.ec/api/payments/payphone/notify/<PAYPHONE_NOTIFY_SECRET>`

## Conductores (pestaña Conductores)
Revisa cada solicitud: compara la selfie con la cédula, verifica licencia **tipo A**
vigente, que la matrícula corresponda a la placa y el código del certificado de
antecedentes penales en el portal oficial. Aprobar crea su billetera. Rechazar o
suspender exige un motivo (el conductor lo ve). Las anomalías de GPS (fake GPS o
saltos imposibles) se muestran en su ficha.

## Alertas SOS (pestaña SOS)
Suena una alerta y el título de la pestaña cambia. Llama al usuario, abre su
ubicación y, si corresponde, coordina con el ECU 911. Marca "Atendiendo" y luego
"Resolver". Deja el panel abierto durante las horas de operación.

## Tarifas (pestaña Tarifas, solo rol owner)
- Fórmula base, mínima, recargo por lluvia, tope de multiplicador y redondeo.
- Clima: *Automático* (OpenWeather), *Forzar lluvia* (un aguacero en Tarqui que la API
  aún no detecta) o *Forzar sin lluvia*.
- Zonas: muestra en vivo solicitudes, motos libres y multiplicador por geocerca.
- Las geocercas iniciales son rectángulos aproximados de Manta: dibuja los límites
  reales en https://geojson.io y actualízalos con `PUT /api/admin/zones/:id`.
- Billetera: comisión (en puntos base: 1000 = 10 %), saldo mínimo y límites de recarga.

## Roles del panel
| Rol | Puede |
|-----|-------|
| `owner` | Todo, incluidas tarifas y zonas |
| `finance` | Recargas, conciliación bancaria, integridad de billeteras |
| `operations` | Conductores, usuarios, alertas SOS |

Crear usuarios del panel (en el servidor):
`docker compose exec api node scripts/create-admin.js correo@dominio.com "Nombre" finance`
