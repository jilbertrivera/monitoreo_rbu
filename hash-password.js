#!/usr/bin/env node
/**
 * Utilidad para generar un hash bcrypt a partir de una contraseña en texto plano.
 *
 * Uso:
 *   node scripts/hash-password.js "miContraseñaActual"
 *
 * Copia el hash resultante (empieza con $2b$...) en la columna de contraseña
 * de la hoja de Google Sheets, reemplazando el texto plano. El servidor detecta
 * automáticamente los hashes y los usuarios en texto plano, sin necesidad de
 * migrar todos a la vez.
 */
const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Uso: node scripts/hash-password.js "contraseña"');
  process.exit(1);
}

const SALT_ROUNDS = 12;

bcrypt.hash(password, SALT_ROUNDS).then(hash => {
  console.log('\nHash bcrypt generado:\n');
  console.log(hash);
  console.log('\nCopia este valor en la columna "password" de la hoja de Usuarios.\n');
}).catch(err => {
  console.error('Error generando hash:', err);
  process.exit(1);
});
