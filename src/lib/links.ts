/**
 * O link de entrega é gerado pelo backend a partir de `STORE_URL`. Quando ele
 * aponta para o mesmo host, navegamos pela rota interna (`/entrega/:token`)
 * para manter SPA; caso contrário, preservamos a URL recebida.
 */
export function deliveryPath(url: string): string {
  const fallbackOrigin = typeof window === 'undefined' ? 'http://localhost:5173' : window.location.origin;
  try {
    const parsed = new URL(url, fallbackOrigin);
    // O token é a credencial: mantemos sempre a rota interna da SPA.
    if (parsed.pathname.startsWith('/entrega/')) {
      return `${parsed.pathname}${parsed.search}`;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
