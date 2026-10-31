-- ============================================================================
-- 0006 PEDIDOS RESERVAS
-- Pedidos, eventos e reservas de unidades com expiração.
-- ============================================================================

--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reference text NOT NULL,
    product_id uuid NOT NULL,
    product_name text NOT NULL,
    quantity integer NOT NULL,
    unit_price_cents integer NOT NULL,
    total_cents integer NOT NULL,
    status public.order_status DEFAULT 'pending_payment'::public.order_status NOT NULL,
    payment_status public.payment_status DEFAULT 'pending'::public.payment_status NOT NULL,
    delivery_status public.delivery_status DEFAULT 'not_ready'::public.delivery_status NOT NULL,
    client_token_hash text NOT NULL,
    idempotency_key text,
    reservation_expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT orders_client_token_hash_check CHECK ((client_token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT orders_idempotency_key_check CHECK (((idempotency_key IS NULL) OR ((char_length(idempotency_key) >= 8) AND (char_length(idempotency_key) <= 128)))),
    CONSTRAINT orders_paid_consistency CHECK (((status <> 'paid'::public.order_status) OR (paid_at IS NOT NULL))),
    CONSTRAINT orders_quantity_check CHECK (((quantity >= 1) AND (quantity <= 20))),
    CONSTRAINT orders_total_cents_check CHECK ((total_cents > 0)),
    CONSTRAINT orders_total_matches_unit_price CHECK ((total_cents = (unit_price_cents * quantity))),
    CONSTRAINT orders_unit_price_cents_check CHECK ((unit_price_cents > 0))
);

--

CREATE TABLE public.order_events (
    id bigint NOT NULL,
    order_id uuid NOT NULL,
    event_type text NOT NULL,
    actor text DEFAULT 'system'::text NOT NULL,
    actor_user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_events_actor_check CHECK ((actor = ANY (ARRAY['system'::text, 'customer'::text, 'admin'::text, 'provider'::text]))),
    CONSTRAINT order_events_event_type_check CHECK (((char_length(event_type) >= 2) AND (char_length(event_type) <= 60)))
);

--

CREATE SEQUENCE public.order_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

ALTER SEQUENCE public.order_events_id_seq OWNED BY public.order_events.id;

--

CREATE TABLE public.stock_reservation_units (
    id bigint NOT NULL,
    reservation_id uuid NOT NULL,
    stock_unit_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone
);

--

CREATE SEQUENCE public.stock_reservation_units_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

ALTER SEQUENCE public.stock_reservation_units_id_seq OWNED BY public.stock_reservation_units.id;

--

CREATE TABLE public.stock_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    status public.reservation_status DEFAULT 'active'::public.reservation_status NOT NULL,
    quantity integer NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stock_reservations_quantity_check CHECK (((quantity >= 1) AND (quantity <= 20))),
    CONSTRAINT stock_reservations_window CHECK ((expires_at > starts_at))
);

--

ALTER TABLE ONLY public.order_events ALTER COLUMN id SET DEFAULT nextval('public.order_events_id_seq'::regclass);

--

ALTER TABLE ONLY public.stock_reservation_units ALTER COLUMN id SET DEFAULT nextval('public.stock_reservation_units_id_seq'::regclass);
