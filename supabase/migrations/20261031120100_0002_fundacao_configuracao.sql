-- ============================================================================
-- 0002 FUNDACAO CONFIGURACAO
-- Configuração operacional (durações de reserva/PIX) e limites.
-- ============================================================================

--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
