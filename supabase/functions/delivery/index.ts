import { createDeps } from '../_shared/deps.ts';
import { handleDelivery } from '../_shared/handlers/delivery.ts';

Deno.serve((request: Request) => handleDelivery(request, createDeps()));
