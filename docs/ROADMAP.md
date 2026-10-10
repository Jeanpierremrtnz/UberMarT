# Hoja de ruta (MVP por fases)

## Fase 1 — Pasajeros en moto (implementada)
- Registro seguro de pasajeros y conductores, KYC con revisión humana.
- Cotización con tarifa dinámica, despacho por cercanía, viaje con PIN, SOS y seguimiento.
- Billetera prepagada: recargas por transferencia (antiduplicados + panel + conciliación) y Payphone.

### Pendiente para lanzar la Fase 1
- Configurar proveedor SMS, Payphone de producción, OpenWeather y teselas de Mapbox/MapTiler.
- Dibujar las geocercas reales de Manta (las iniciales son aproximadas).
- Ajustar tarifas iniciales con datos reales del mercado de Manta.
- Esquemas (flavors) de iOS en Xcode; íconos y pantallas de inicio con tu marca.
- Política de privacidad (LOPDP), términos de uso y revisión legal con ANT / GAD Manta.
- Prueba piloto cerrada con 10-20 conductores antes de abrir al público.

## Mejoras recomendadas (sin cambiar la arquitectura)
- Verificación de identidad contra el Registro Civil (proveedores autorizados vía DINARDAP)
  y comparación facial automática de la selfie.
- Lectura automática (OCR) del comprobante para pre-llenar y contrastar referencia y monto.
- Llamadas/chat enmascarados entre pasajero y conductor dentro de la app.
- Adaptador de Kushki como segunda pasarela (misma interfaz que Payphone: crear link,
  confirmar servidor-a-servidor y acreditar de forma idempotente).
- Notificaciones push (Firebase Cloud Messaging) cuando la app está cerrada.
- Panel: mapa en vivo de motos y editor visual de geocercas.
- Retención automática de datos (p. ej. recorridos 90 días) según la política de privacidad.

## Fase 2 — Mensajería (implementada)
Mismo motor de despacho: datos del paquete, foto al recoger y al entregar, PIN del
remitente al recoger y PIN del destinatario (por SMS) al entregar.

## Fase 3 — Delivery de comida (implementada)
Panel web `/comercio` para que los restaurantes se registren, carguen productos y
reciban pedidos; el panel interno los verifica. El motorizado paga la comida al
local y cobra el total al cliente, que confirma con su PIN de entrega.

### Mejoras sugeridas para delivery
- Pago en línea del cliente con Payphone (hoy es efectivo contra entrega).
- Cuentas adicionales para el personal del local (hoy una cuenta por local).
- Horario automático de apertura/cierre y "agotado" por horario.
- Combinar pedidos del mismo local en una sola moto.

## Crecimiento técnico
- Varias instancias de la API: Redis para Socket.io y límites de solicitudes.
- Archivos en DigitalOcean Spaces/S3 (siguen cifrados por la aplicación).
- Réplica de lectura de PostgreSQL y monitoreo (Uptime Kuma / Grafana).
