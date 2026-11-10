// Aplica as migrations em ordem num banco (DATABASE_URL). Uso: npm run migrar
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não definida');
  process.exit(1);
}
const pasta = 'supabase/migrations';
const cliente = new pg.Client({ connectionString: url });
await cliente.connect();
for (const arquivo of readdirSync(pasta).filter((f) => f.endsWith('.sql')).sort()) {
  await cliente.query(readFileSync(join(pasta, arquivo), 'utf8'));
  console.log(`aplicada: ${arquivo}`);
}
await cliente.end();
