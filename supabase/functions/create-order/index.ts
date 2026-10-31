import { createDeps } from '../_shared/deps.ts';
import { handleCreateOrder } from '../_shared/handlers/createOrder.ts';

Deno.serve((request: Request) => handleCreateOrder(request, createDeps()));
