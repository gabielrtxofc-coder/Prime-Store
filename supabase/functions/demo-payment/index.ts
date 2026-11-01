import { withCors } from '../_shared/cors.ts';
import { createDeps } from '../_shared/deps.ts';
import { handleDemoPayment } from '../_shared/handlers/demoPayment.ts';

/**
 * A política de CORS depende da origem da requisição, então é aplicada na
 * borda: o handler devolve a resposta e `withCors` decide se o navegador
 * daquela origem pode lê-la.
 */
Deno.serve(async (request: Request) => {
  const deps = createDeps();
  const response = await handleDemoPayment(request, deps);
  return withCors(request, response, deps.config);
});
