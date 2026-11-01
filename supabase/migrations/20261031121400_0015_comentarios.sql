-- ============================================================================
-- COMENTÁRIOS DE DOCUMENTAÇÃO (catálogo, funções e tabelas)
-- ============================================================================
-- Mantidos dentro do banco para que `\d+` e o editor SQL do Supabase
-- expliquem as regras de negócio. Não alteram comportamento.

COMMENT ON FUNCTION public.apply_payment_status(p_order_id uuid, p_provider_payment_id text, p_provider_status text, p_status_detail text, p_amount_cents integer, p_delivery_token_hash text, p_delivery_token_enc_b64 text) IS 'Conciliação idempotente de pagamento. Cobre aprovação normal, aprovação tardia com/sem estoque, recusa, estorno e divergência de valor.';

COMMENT ON FUNCTION public.assert_admin() IS 'Garante sessão autenticada + allowlist administrativa + AAL2 (MFA). Falha com SQLSTATE 42501/28000.';

COMMENT ON FUNCTION public.create_order(p_product_id uuid, p_quantity integer, p_idempotency_key text, p_client_token_hash text) IS 'Cria pedido, reserva unidades com FOR UPDATE SKIP LOCKED e devolve os dados públicos. Preço e disponibilidade vêm do banco.';

COMMENT ON FUNCTION public.expire_overdue_reservations(p_product_id uuid) IS 'Expira reservas vencidas, devolve unidades ao estoque disponível e marca pedidos como expired. Idempotente.';

COMMENT ON FUNCTION public.resolve_delivery(p_token_hash text) IS 'Entrega apenas de pedido pago, aprovado e com entrega pronta. Token é hash SHA-256; devolve credenciais cifradas para a Edge Function decifrar.';

COMMENT ON FUNCTION public.setting_int(p_key text, p_default integer) IS 'Lê um inteiro de app_settings com fallback.';

COMMENT ON TABLE public.admin_audit_log IS 'Trilha de auditoria das operações administrativas relevantes. Nunca registrar credenciais de estoque nem tokens de entrega.';

COMMENT ON TABLE public.admin_users IS 'Allowlist de administradores da Prime Store. Ambos os papéis (owner/admin) têm as mesmas permissões efetivas na V1; o campo é apenas informativo.';

COMMENT ON TABLE public.deliveries IS 'Entrega privada por pedido pago. Token aleatório de 32 bytes; banco guarda apenas hash + ciphertext. Revogável por administrador.';

COMMENT ON TABLE public.payment_events IS 'Caixa de entrada idempotente de webhooks. O conteúdo recebido nunca é usado como fonte de verdade: o handler reconfere o pagamento na API do provedor.';

COMMENT ON TABLE public.stock_units IS 'Linha de estoque = uma credencial de conta. E-mail e senha somente em ciphertext; fingerprint HMAC identifica duplicados sem revelar o conteúdo.';

COMMENT ON COLUMN public.stock_units.credential_fingerprint IS 'HMAC-SHA256 hexadecimal de (email + senha), calculado fora do banco. Nunca deriva da senha em claro.';

COMMENT ON VIEW public.public_catalog IS 'Único ponto de leitura pública de catálogo. Não expõe cost_cents, credenciais nem unidades individuais.';

COMMENT ON TABLE public.refund_requests IS 'Pendências de reembolso. O reembolso é sempre executado manualmente por um administrador no Mercado Pago; nenhum estorno automático é feito pela Prime Store.';

COMMENT ON TABLE public.stock_reservation_units IS 'Alocação de unidades a reservas. O índice parcial único em stock_unit_id WHERE released_at IS NULL impede alocação simultânea da mesma unidade.';
