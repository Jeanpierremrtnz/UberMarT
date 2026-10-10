import { generateKeyPairSync, randomBytes } from 'node:crypto';

// Genera los secretos de producción. Guárdalos SOLO en el .env del servidor
// (nunca en el repositorio) y en un gestor de contraseñas como respaldo.
const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

console.log(`APP_MASTER_KEY=${randomBytes(32).toString('base64')}`);
console.log(`JWT_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}`);
console.log(`PAYPHONE_NOTIFY_SECRET=${randomBytes(32).toString('base64url')}`);
console.log(`POSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}`);
console.log(`OWNER_DB_PASSWORD=${randomBytes(24).toString('base64url')}`);
console.log(`APP_DB_PASSWORD=${randomBytes(24).toString('base64url')}`);
