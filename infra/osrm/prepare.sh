#!/usr/bin/env bash
# Prepara el motor de rutas OSRM con el mapa de OpenStreetMap de Ecuador,
# recortado a Manabí para que use poca memoria en el servidor.
#
# Requisitos: docker y (recomendado) osmium-tool  ->  sudo apt install osmium-tool
# Sugerencia: ejecútalo en tu computadora y sube la carpeta data/ al servidor
# (el preprocesamiento necesita más RAM que la ejecución).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
IMAGE=ghcr.io/project-osrm/osrm-backend:v5.27.1

curl -fL --retry 3 -o data/ecuador-latest.osm.pbf https://download.geofabrik.de/south-america/ecuador-latest.osm.pbf

if command -v osmium >/dev/null 2>&1; then
  # Manabí y alrededores (Manta, Portoviejo, Chone, Montecristi, Jaramijó).
  osmium extract --overwrite --bbox -81.10,-1.70,-79.70,0.45 data/ecuador-latest.osm.pbf -o data/manabi.osm.pbf
else
  echo "osmium no está instalado; se usará todo Ecuador (requiere más memoria)"
  cp data/ecuador-latest.osm.pbf data/manabi.osm.pbf
fi

# Perfil "car": las motos circulan por las mismas vías. Ajusta el factor de
# tiempo de las motos en el panel (Tarifas -> Factor de tiempo moto).
docker run --rm -t -v "$PWD/data:/data" "$IMAGE" osrm-extract -p /opt/car.lua /data/manabi.osm.pbf
docker run --rm -t -v "$PWD/data:/data" "$IMAGE" osrm-partition /data/manabi.osrm
docker run --rm -t -v "$PWD/data:/data" "$IMAGE" osrm-customize /data/manabi.osrm
rm -f data/ecuador-latest.osm.pbf
echo "Listo. Archivos en infra/osrm/data (súbelos al servidor en la misma ruta)."
