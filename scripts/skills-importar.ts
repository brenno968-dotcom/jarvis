// Item 793 (skills): `npm run skills:importar -- <url-github-ou-pasta> [--com-scripts] [--destino <pasta>]`
// Importa uma skill de terceiro para skills/ SÓ depois de validar (frontmatter, scanner de injeção, sem script habilitado).
// A skill entra com `origem: externa` e `ferramentas_permitidas` vazia até o Breno editar o SKILL.md.
import { importarSkill, resolverDiretorioSkills } from '../packages/core/src/skills/index.ts';

const args = process.argv.slice(2);
const comScripts = args.includes('--com-scripts');
const iDest = args.indexOf('--destino');
const destino = iDest >= 0 ? args[iDest + 1] : undefined;
const origem = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--destino');

if (!origem || (iDest >= 0 && !destino)) {
  console.error('uso: npm run skills:importar -- <url-github-ou-pasta> [--com-scripts] [--destino <pasta>]');
  process.exit(2);
}

const r = await importarSkill(origem, { destino: destino ?? resolverDiretorioSkills(), comScripts });
for (const a of r.avisos) console.log(`aviso: ${a}`);
if (!r.ok) {
  for (const m of r.recusas) console.error(`RECUSADA: ${m}`);
  process.exit(1);
}
console.log(`Importada: skills/${r.nome} (${r.copiados.length} arquivo(s)). origem: externa, ferramentas_permitidas vazia.`);
console.log('Revise o SKILL.md e, se quiser que ela use ferramentas, edite ferramentas_permitidas na mão.');
