import type { NextConfig } from 'next';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '../..');

const config: NextConfig = {
  transpilePackages: ['@jarvis/core'],
  serverExternalPackages: ['pg'],
  poweredByHeader: false,
  // Monorepo: o painel lê config/regras.yaml da raiz em tempo de execução.
  outputFileTracingRoot: raiz,
  outputFileTracingIncludes: { '/**': ['../../config/regras.yaml'] },
};

export default config;
