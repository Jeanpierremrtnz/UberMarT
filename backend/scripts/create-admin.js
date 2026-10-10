import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/app.js';

// Uso: npm run admin:create -- correo@dominio.com "Nombre Apellido" owner
// La contraseña se pide por consola (no queda en el historial del shell).
const [email, fullName, role = 'owner'] = process.argv.slice(2);
if (!email || !fullName) {
  console.error('Uso: npm run admin:create -- <email> "<nombre completo>" [owner|finance|operations]');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question('Contraseña (12+ caracteres): ');
rl.close();

const ctx = createContext(loadConfig());
try {
  const out = await ctx.services.adminAuth.createAdmin({ email, fullName, password, role });
  console.log('\nAdministrador creado.');
  console.log('Configura el segundo factor en Google Authenticator / Authy:');
  console.log(`  Clave: ${out.totpSecret}`);
  console.log(`  URI:   ${out.totpUri}`);
  console.log('Guarda la clave en un lugar seguro; no se volverá a mostrar.');
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await ctx.db.close();
}
