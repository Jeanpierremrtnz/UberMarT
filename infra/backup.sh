#!/usr/bin/env bash
# Respaldo cifrado diario de la base de datos y de los archivos (documentos y
# comprobantes, que ya están cifrados en disco). Programar con cron:
#   15 3 * * * /opt/ubermart/infra/backup.sh >> /var/log/ubermart-backup.log 2>&1
# Requiere BACKUP_PASSPHRASE en /root/.ubermart-backup (chmod 600) y gpg.
# Copia luego los .gpg fuera del servidor (DigitalOcean Spaces / S3 con rclone).
set -euo pipefail
cd "$(dirname "$0")"
DEST=${BACKUP_DIR:-/var/backups/ubermart}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
PASSFILE=${PASSFILE:-/root/.ubermart-backup}
mkdir -p "$DEST"
chmod 700 "$DEST"

docker compose exec -T db pg_dump -U postgres -Fc ubermart \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o "$DEST/db-$STAMP.dump.gpg"

docker run --rm -v ubermart_storage:/data:ro alpine tar -C /data -cz . \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASSFILE" -o "$DEST/storage-$STAMP.tgz.gpg"

find "$DEST" -name '*.gpg' -mtime +14 -delete
echo "Respaldo $STAMP completado"
