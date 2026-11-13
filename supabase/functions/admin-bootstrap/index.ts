import { withCors } from '../_shared/cors.ts';
import { createDeps } from '../_shared/deps.ts';
import { handleAdminBootstrap } from '../_shared/handlers/adminBootstrap.ts';

/**
 * Configuração inicial TEMPORÁRIA do painel administrativo (duas contas,
 * código de uso restrito, auto-encerramento). Ver `configuracao-inicial-admin.md`.
 *
 * A política de CORS depende da origem da requisição, então é aplicada na
 * borda: o handler devolve a resposta e `withCors` decide se o navegador
 * daquela origem pode lê-la.
 */
Deno.serve(async (request: Request) => {
  const deps = createDeps();
  const response = await handleAdminBootstrap(request, deps);
  return withCors(request, response, deps.config);
});
