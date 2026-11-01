-- ============================================================================
-- 0007 PAGAMENTOS
-- Cobranças PIX, eventos de webhook e pedidos de reembolso.
-- ============================================================================

--

CREATE TABLE public.payment_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text DEFAULT 'mercado_pago'::text NOT NULL,
    notification_id text,
    event_type text,
    action text,
    data_id text,
    signature_valid boolean,
    payload_hash text NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    CONSTRAINT payment_events_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT payment_events_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT payment_events_provider_check CHECK ((provider = 'mercado_pago'::text)),
    CONSTRAINT payment_events_status_check CHECK ((status = ANY (ARRAY['received'::text, 'processed'::text, 'ignored'::text, 'failed'::text, 'duplicate'::text])))
);

--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    provider text DEFAULT 'mercado_pago'::text NOT NULL,
    provider_payment_id text,
    method text DEFAULT 'pix'::text NOT NULL,
    status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    status_detail text,
    amount_cents integer NOT NULL,
    qr_code text,
    qr_code_base64 text,
    ticket_url text,
    expires_at timestamp with time zone,
    approved_at timestamp with time zone,
    provider_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payments_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT payments_method_check CHECK ((method = 'pix'::text)),
    CONSTRAINT payments_provider_check CHECK ((provider = 'mercado_pago'::text))
);

--

CREATE TABLE public.refund_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider_payment_id text,
    amount_cents integer NOT NULL,
    created_by text DEFAULT 'system'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    notes text DEFAULT ''::text NOT NULL,
    CONSTRAINT refund_requests_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT refund_requests_created_by_check CHECK ((created_by = ANY (ARRAY['system'::text, 'admin'::text]))),
    CONSTRAINT refund_requests_reason_check CHECK (((char_length(btrim(reason)) >= 3) AND (char_length(btrim(reason)) <= 500))),
    CONSTRAINT refund_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'authorized'::text, 'processed'::text, 'rejected'::text])))
);
