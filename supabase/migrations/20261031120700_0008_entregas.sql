-- ============================================================================
-- 0008 ENTREGAS
-- Links privados de entrega e vínculo com as unidades vendidas.
-- ============================================================================

--

CREATE TABLE public.deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_enc bytea NOT NULL,
    status public.delivery_link_status DEFAULT 'active'::public.delivery_link_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    revoke_reason text,
    view_count integer DEFAULT 0 NOT NULL,
    last_viewed_at timestamp with time zone,
    CONSTRAINT deliveries_revoke_reason_check CHECK (((revoke_reason IS NULL) OR (char_length(revoke_reason) <= 500))),
    CONSTRAINT deliveries_revoked_consistency CHECK ((((status = 'active'::public.delivery_link_status) AND (revoked_at IS NULL)) OR ((status = 'revoked'::public.delivery_link_status) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT deliveries_token_enc_check CHECK (((octet_length(token_enc) >= 28) AND (octet_length(token_enc) <= 4096))),
    CONSTRAINT deliveries_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT deliveries_view_count_check CHECK ((view_count >= 0))
);

--

CREATE TABLE public.delivery_units (
    id bigint NOT NULL,
    delivery_id uuid NOT NULL,
    stock_unit_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--

CREATE SEQUENCE public.delivery_units_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

ALTER SEQUENCE public.delivery_units_id_seq OWNED BY public.delivery_units.id;

--

ALTER TABLE ONLY public.delivery_units ALTER COLUMN id SET DEFAULT nextval('public.delivery_units_id_seq'::regclass);
