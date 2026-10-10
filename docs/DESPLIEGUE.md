# Despliegue

## 1. Servidor

DigitalOcean Droplet (o AWS Lightsail) con Ubuntu 24.04:
- **2 GB RAM ($12/mes)** para empezar; **4 GB** si OSRM y PostgreSQL crecen.
- Región más cercana con buena latencia a Ecuador (p. ej. Nueva York o San Francisco).

Endurecimiento básico:

```bash
adduser deploy && usermod -aG sudo deploy        # trabaja con un usuario sin root
# Copia tu llave SSH y desactiva contraseñas y root en /etc/ssh/sshd_config:
#   PasswordAuthentication no
#   PermitRootLogin no
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
sudo apt install -y unattended-upgrades fail2ban gnupg
# Docker oficial: https://docs.docker.com/engine/install/ubuntu/
```

Apunta el DNS (registro A) de `api.tudominio.ec` a la IP del servidor.

## 2. Código y secretos

```bash
git clone git@github.com:<tu-usuario>/UberMarT.git /opt/ubermart   # repo privado, llave de despliegue de solo lectura
cd /opt/ubermart
docker run --rm -v "$PWD/backend/scripts:/s:ro" node:22.22.0-bookworm-slim node /s/gen-secrets.js   # anota los valores
cd infra
cp .env.example .env            # dominio, correo, contraseñas de BD, ADMIN_ALLOWED_IPS
cp api.env.example api.env      # PUBLIC_BASE_URL, APP_MASTER_KEY, JWT_PRIVATE_KEY, Twilio, Payphone, OpenWeather
chmod 600 .env api.env
```

**Guarda `APP_MASTER_KEY` en un gestor de contraseñas.** Si se pierde, los datos
cifrados (cédulas, documentos, comprobantes) no se pueden recuperar.

## 3. Motor de rutas (OSRM)

En tu computadora (necesita más RAM que el servidor):

```bash
sudo apt install osmium-tool
infra/osrm/prepare.sh
rsync -av infra/osrm/data/ deploy@servidor:/opt/ubermart/infra/osrm/data/
```

Sin OSRM la API sigue funcionando con una estimación (distancia en línea recta × 1,35).

## 4. Levantar

```bash
cd /opt/ubermart/infra
docker compose up -d --build db
docker compose run --rm migrate          # crea las tablas con el usuario dueño
docker compose up -d --build             # api, osrm y caddy (HTTPS automático)
docker compose run --rm api node scripts/create-admin.js tu@correo.com "Tu Nombre" owner
curl https://api.tudominio.ec/healthz
```

Actualizar a una nueva versión:

```bash
git pull && docker compose build api migrate && docker compose run --rm migrate && docker compose up -d api
```

## 5. Respaldos

```bash
sudo sh -c 'openssl rand -base64 32 > /root/.ubermart-backup && chmod 600 /root/.ubermart-backup'
sudo crontab -e   # 15 3 * * * /opt/ubermart/infra/backup.sh >> /var/log/ubermart-backup.log 2>&1
```

Copia los `.gpg` fuera del servidor (DigitalOcean Spaces con `rclone`) y guarda la
frase de respaldo junto a `APP_MASTER_KEY`. Prueba restaurar al menos una vez:
`gpg -d db-....dump.gpg | docker compose exec -T db pg_restore -U postgres -d ubermart_restore`.

## 6. Apps móviles

```bash
cd mobile
# Android: crea tu keystore UNA vez y guárdalo fuera del repositorio
keytool -genkey -v -keystore ~/ubermart-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias ubermart
# android/key.properties (no se sube): storeFile, storePassword, keyAlias, keyPassword
flutter build appbundle --flavor passenger -t lib/main_passenger.dart \
  --dart-define=API_BASE_URL=https://api.tudominio.ec \
  --dart-define=TILE_URL="https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}@2x?access_token=TU_TOKEN" \
  --dart-define=TILE_ATTRIBUTION="© Mapbox © OpenStreetMap" \
  --obfuscate --split-debug-info=build/symbols
flutter build appbundle --flavor driver -t lib/main_driver.dart  (mismos --dart-define)
```

- Usa un token de Mapbox **público restringido** a tus apps; nunca un token secreto.
- iOS: crea en Xcode los esquemas `passenger` y `driver` (mismos targets, distinto
  Bundle ID) antes de publicar en App Store.
- Google Play exigirá justificar la ubicación en segundo plano de la app del conductor
  (servicio en primer plano con notificación mientras está "En línea").
