# Modelo de seguridad

Ningún sistema es "inhackeable". El objetivo es que atacarlo sea caro, que cada
capa falle de forma segura y que todo intento quede registrado. Este documento
resume las amenazas consideradas y los controles implementados.

## 1. Registro de usuarios (pasajeros y conductores)

| Amenaza | Control |
|---------|---------|
| Cuentas falsas / bots | Ingreso solo con celular ecuatoriano verificado por SMS (OTP de 6 dígitos, 5 min) |
| Fuerza bruta del OTP | Máx. 5 intentos por código, 3 SMS cada 15 min y 8 por día por número, límites por IP |
| Fraude de SMS (toll fraud) | Solo números móviles +593 9XXXXXXXX |
| Suplantación / multicuentas para evadir bloqueos | Cédula obligatoria validada con el algoritmo del Registro Civil y **única** en todo el sistema (índice ciego HMAC) |
| Filtración de datos personales | Cédula y licencia cifradas con AES-256-GCM, ligadas a su registro (AAD); los documentos KYC y comprobantes se guardan cifrados en disco |
| Cambio de identidad tras ser verificado | Cédula inmodificable; nombre bloqueado mientras la solicitud de conductor está en revisión o aprobada |
| Conductores sin requisitos | KYC con 8 documentos (cédula, licencia tipo A, matrícula, antecedentes penales, selfie, foto de la moto), revisión humana, placa única, licencia vigente para conectarse |
| Reutilizar documentos de otra persona | Cada imagen de documento solo puede usarse una vez en todo el sistema (hash del archivo original) |

## 2. Sesiones y API

- Tokens de acceso **JWT EdDSA (Ed25519)** de 15 minutos; se rechazan `alg: none` y firmas alteradas.
- Tokens de refresco opacos (solo se guarda su HMAC), ligados al dispositivo, con
  **rotación**: si un token viejo se reutiliza (señal de robo) se revoca toda la sesión.
- En cada solicitud se verifica en BD que la sesión siga activa y que el usuario no
  esté suspendido: un bloqueo surte efecto inmediato (incluido el WebSocket).
- Autorización a nivel de objeto: un usuario solo ve sus viajes, recargas y documentos
  (las respuestas son 404 para no revelar que el recurso existe).
- Validación estricta (zod), SQL parametrizado, límites de tamaño (JSON 32 KB,
  imágenes 8 MB, mensajes WebSocket 2 KB), límites de frecuencia por IP y por usuario.
- Cabeceras: CSP estricta, HSTS, `nosniff`, `frame-ancestors 'none'`, sin `X-Powered-By`,
  respuestas `Cache-Control: no-store`. Errores sin detalles internos.
- Imágenes: se verifica el formato real, se limitan los píxeles (anti "bombas"), se
  eliminan metadatos (EXIF/GPS) y se re-codifican a JPEG (neutraliza archivos políglotas).

## 3. Dinero (recargas y comisiones)

- Libro contable **de solo-anexar**: triggers impiden UPDATE/DELETE/TRUNCATE y, además,
  el usuario de BD de la API no tiene esos permisos (doble barrera).
- Restricción única `(tipo, referencia)`: imposible acreditar dos veces la misma
  recarga o cobrar dos veces la comisión de un viaje, aun con doble clic o reintentos.
- Reporte de integridad: cada saldo debe ser igual a la suma de su libro contable.
- Recargas por transferencia: referencia normalizada y única globalmente (sin importar
  banco, ceros a la izquierda o guiones), imagen única, máximo 3 pendientes por conductor,
  conciliación contra el estado de cuenta del banco y suspensión automática por fraude.
- Payphone: nunca se confía en la redirección ni en el webhook; se confirma con la API
  de Payphone y se exige estado aprobado, id de transacción propio y **monto exacto**.
  El webhook además exige un secreto en la URL. Cada transacción de la pasarela solo
  puede acreditar una vez.

## 4. Viaje y seguridad física

- **PIN de abordaje** de 4 dígitos: el viaje solo inicia si el pasajero dicta su PIN
  (evita subir a la moto equivocada). Máx. 5 intentos.
- Datos mínimos entre las partes: primer nombre, placa y moto; nunca teléfonos ni cédulas.
- **SOS**: alerta inmediata al panel (con sonido), SMS a hasta 3 contactos de emergencia
  con ubicación y link de seguimiento, y acceso directo al 911.
- Link de seguimiento: token aleatorio de 144 bits, solo lectura, expira al terminar.
- El recorrido de cada viaje se guarda para investigar incidentes.
- La llegada al punto de recogida se valida con el GPS (máx. 300 m).
- GPS simulado (apps de "fake GPS") y saltos imposibles se descartan y se registran.
- Los pasajeros no pueden ver la ubicación de motos no asignadas.

## 5. Panel administrativo

- Contraseña con Argon2id (64 MB) + **TOTP obligatorio** (Google Authenticator/Authy)
  con protección anti-reutilización del código.
- Bloqueo de 15 min tras 5 intentos fallidos; mismo mensaje para correos inexistentes.
- Sesión en cookie `__Host-` HttpOnly, Secure, SameSite=Strict; 30 min de inactividad, 8 h máximo.
- Token CSRF obligatorio en toda escritura.
- Roles: `owner` (todo), `finance` (recargas y conciliación), `operations` (conductores,
  usuarios y SOS). Solo `owner` cambia tarifas y zonas.
- Ver datos personales completos de un conductor queda en la auditoría.
- Caddy puede restringir el panel a las IP de tu oficina o VPN (`ADMIN_ALLOWED_IPS`).

## 6. Infraestructura

- Solo los puertos 80/443 expuestos; PostgreSQL y OSRM en red interna de Docker.
- Contenedores sin privilegios: usuario no root, sistema de archivos de solo lectura,
  `cap_drop: ALL`, `no-new-privileges`, Node con `--disable-proto=delete`.
- Base de datos con mínimo privilegio: las migraciones usan `ubermart_owner`; la API usa
  `ubermart_app`, que no puede alterar tablas ni modificar el libro contable o la auditoría.
- Secretos solo en archivos `.env` del servidor (nunca en el repositorio). Claves derivadas
  con HKDF a partir de una clave maestra; JWT con clave asimétrica separada.
- Respaldos diarios cifrados (GPG AES-256) de la base de datos y los archivos.
- Apps: sin tráfico HTTP en producción, tokens en Keychain/Keystore, respaldo en la nube
  desactivado, la app se niega a usar una API sin HTTPS en modo release.

## 7. Auditoría

La tabla `audit_log` (solo-anexar) registra inicios de sesión, intentos fallidos,
reutilización de tokens, recargas, aprobaciones/rechazos, intentos de duplicado,
cambios de tarifas, vistas de datos personales, suspensiones, SOS y anomalías de GPS.

## 8. Antes de salir a producción (lista de verificación)

- [ ] Dominio propio con HTTPS (Caddy lo emite solo) y `ADMIN_ALLOWED_IPS` configurado.
- [ ] Secretos generados con `npm run gen:secrets` y guardados en un gestor de contraseñas.
- [ ] Twilio (u otro proveedor SMS) con remitente aprobado; `SMS_PROVIDER=console` está bloqueado en producción.
- [ ] Credenciales de Payphone de producción y URL de notificación con su secreto.
- [ ] Respaldos programados y **una restauración de prueba** realizada.
- [ ] Servidor: acceso SSH solo con llave, firewall (ufw) 22/80/443, actualizaciones automáticas.
- [ ] App firmada con tu propio keystore (guardado fuera del repositorio).
- [ ] Prueba de penetración externa antes del lanzamiento público.
- [ ] Política de privacidad y términos de uso conforme a la **LOPDP** (Ley Orgánica de
      Protección de Datos Personales), con plazos de conservación de documentos y recorridos.
- [ ] Revisión legal de la operación de transporte en moto con la ANT y el GAD de Manta.
- [ ] Registro de la marca y del software (derechos de autor) en el **SENADI**.
