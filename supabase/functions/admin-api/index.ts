import { createDeps } from '../_shared/deps.ts';
import { handleAdminApi } from '../_shared/handlers/adminApi.ts';

Deno.serve((request: Request) => handleAdminApi(request, createDeps()));
