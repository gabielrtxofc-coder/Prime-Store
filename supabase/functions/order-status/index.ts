import { createDeps } from '../_shared/deps.ts';
import { handleOrderStatus } from '../_shared/handlers/orderStatus.ts';

Deno.serve((request: Request) => handleOrderStatus(request, createDeps()));
