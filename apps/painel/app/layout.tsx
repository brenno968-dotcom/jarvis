import type { ReactNode } from 'react';
import './estilo.css';

export const metadata = { title: 'Jarvis — painel', robots: { index: false, follow: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
