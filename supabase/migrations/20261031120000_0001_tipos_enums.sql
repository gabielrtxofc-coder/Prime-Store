-- ============================================================================
-- 0001 TIPOS ENUMS
-- Tipos enumerados do domínio (estados de pedido, pagamento, estoque, entrega).
-- ============================================================================

--

CREATE TYPE public.delivery_link_status AS ENUM (
    'active',
    'revoked'
);

--

CREATE TYPE public.delivery_status AS ENUM (
    'not_ready',
    'ready',
    'revoked',
    'blocked'
);

--

CREATE TYPE public.order_status AS ENUM (
    'pending_payment',
    'paid',
    'expired',
    'cancelled',
    'refund_pending',
    'refunded',
    'failed'
);

--

CREATE TYPE public.payment_status AS ENUM (
    'pending',
    'in_process',
    'approved',
    'rejected',
    'cancelled',
    'refunded',
    'charged_back',
    'amount_mismatch'
);

--

CREATE TYPE public.reservation_status AS ENUM (
    'active',
    'consumed',
    'expired',
    'released'
);

--

CREATE TYPE public.stock_unit_status AS ENUM (
    'available',
    'reserved',
    'sold',
    'disabled'
);
