import { createDeps } from '../_shared/deps.ts';
import { handleCatalog } from '../_shared/handlers/catalog.ts';

Deno.serve((request: Request) => handleCatalog(request, createDeps()));
