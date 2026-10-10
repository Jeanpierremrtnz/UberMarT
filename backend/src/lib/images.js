import sharp from 'sharp';
import { badRequest } from './errors.js';
import { sha256Hex } from './crypto.js';

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MAX_INPUT_PIXELS = 40_000_000;

sharp.cache(false);
sharp.concurrency(1);

/**
 * Re-codifica una imagen subida por el usuario:
 *  - verifica el formato real por su contenido (no por la extensión o el MIME),
 *  - limita el tamaño en píxeles (evita "bombas" de descompresión),
 *  - corrige la orientación y elimina TODOS los metadatos (EXIF/GPS),
 *  - genera un JPEG nuevo, neutralizando archivos políglotas o con payloads.
 * Devuelve también el hash del archivo original para detectar reutilización.
 */
export async function sanitizeImage(input, { maxSide = 1600, quality = 82 } = {}) {
  if (!Buffer.isBuffer(input) || input.length === 0) throw badRequest('IMAGE_REQUIRED', 'Falta la imagen');
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).metadata();
  } catch {
    throw badRequest('IMAGE_INVALID', 'La imagen no es válida');
  }
  if (!ALLOWED_FORMATS.has(meta.format)) {
    throw badRequest('IMAGE_FORMAT', 'Formato no permitido (usa JPG, PNG o WEBP)');
  }
  if (!meta.width || !meta.height || meta.width < 200 || meta.height < 200) {
    throw badRequest('IMAGE_TOO_SMALL', 'La imagen es demasiado pequeña o ilegible');
  }
  let out;
  try {
    out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw badRequest('IMAGE_INVALID', 'La imagen no es válida');
  }
  return {
    buffer: out.data,
    width: out.info.width,
    height: out.info.height,
    bytes: out.data.length,
    sourceSha256: sha256Hex(input),
    mime: 'image/jpeg',
  };
}
