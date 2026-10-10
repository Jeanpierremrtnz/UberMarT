import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { decrypt, encrypt } from './crypto.js';

const KEY_PATTERN = /^[a-z_]+\/[0-9]{4}\/[0-9]{2}\/[0-9a-f-]{36}\.bin$/;

/**
 * Almacén de archivos sensibles (cédulas, licencias, comprobantes) cifrados
 * con AES-256-GCM en disco, fuera de cualquier carpeta pública. Solo se leen a
 * través de endpoints autenticados del panel.
 */
export function createEncryptedStorage({ rootDir, key }) {
  const root = path.resolve(rootDir);

  const resolveKey = (storageKey) => {
    if (!KEY_PATTERN.test(storageKey)) throw new Error('storage key inválida');
    const full = path.resolve(root, storageKey);
    if (!full.startsWith(root + path.sep)) throw new Error('storage key fuera de la raíz');
    return full;
  };

  return {
    async put(category, buffer) {
      if (!/^[a-z_]+$/.test(category)) throw new Error('categoría inválida');
      const now = new Date();
      const storageKey = `${category}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.bin`;
      const full = resolveKey(storageKey);
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      const tmp = `${full}.tmp`;
      await writeFile(tmp, encrypt(key, buffer, storageKey), { mode: 0o600, flag: 'wx' });
      await rename(tmp, full);
      return storageKey;
    },
    async get(storageKey) {
      const payload = await readFile(resolveKey(storageKey));
      return decrypt(key, payload, storageKey);
    },
    async remove(storageKey) {
      await unlink(resolveKey(storageKey)).catch(() => {});
    },
  };
}
