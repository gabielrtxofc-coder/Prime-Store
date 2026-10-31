import { createDeps } from '../_shared/deps.ts';
import { handleMpWebhook } from '../_shared/handlers/mpWebhook.ts';

Deno.serve((request: Request) => handleMpWebhook(request, createDeps()));
