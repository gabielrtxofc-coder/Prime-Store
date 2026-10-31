import { createDeps } from '../_shared/deps.ts';
import { handleDemoPayment } from '../_shared/handlers/demoPayment.ts';

Deno.serve((request: Request) => handleDemoPayment(request, createDeps()));
