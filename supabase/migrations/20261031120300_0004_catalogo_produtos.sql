-- ============================================================================
-- 0004 CATALOGO PRODUTOS
-- Categorias, produtos, histórico de preços e custo.
-- ============================================================================

--

CREATE TABLE public.product_categories (
    id text NOT NULL,
    label text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_categories_id_check CHECK ((id ~ '^[a-z0-9][a-z0-9-]{1,39}$'::text)),
    CONSTRAINT product_categories_label_check CHECK (((char_length(btrim(label)) >= 2) AND (char_length(btrim(label)) <= 60)))
);

--

CREATE TABLE public.product_price_history (
    id bigint NOT NULL,
    product_id uuid NOT NULL,
    old_price_cents integer,
    new_price_cents integer NOT NULL,
    old_cost_cents integer,
    new_cost_cents integer NOT NULL,
    changed_by uuid,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);

--

CREATE SEQUENCE public.product_price_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

ALTER SEQUENCE public.product_price_history_id_seq OWNED BY public.product_price_history.id;

--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    short_description text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    image_url text,
    category_id text NOT NULL,
    price_cents integer NOT NULL,
    cost_cents integer DEFAULT 0 NOT NULL,
    access_validity_days integer,
    access_validity_label text DEFAULT ''::text NOT NULL,
    instructions text DEFAULT ''::text NOT NULL,
    conditions text[] DEFAULT '{}'::text[] NOT NULL,
    modality text DEFAULT ''::text NOT NULL,
    period text DEFAULT ''::text NOT NULL,
    monogram text DEFAULT ''::text NOT NULL,
    theme text DEFAULT 'blue'::text NOT NULL,
    max_quantity_per_order integer DEFAULT 1 NOT NULL,
    is_featured boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_by uuid,
    CONSTRAINT products_access_validity_days_check CHECK (((access_validity_days IS NULL) OR ((access_validity_days >= 1) AND (access_validity_days <= 3650)))),
    CONSTRAINT products_access_validity_label_check CHECK ((char_length(access_validity_label) <= 120)),
    CONSTRAINT products_cost_cents_check CHECK (((cost_cents >= 0) AND (cost_cents <= 100000000))),
    CONSTRAINT products_description_check CHECK ((char_length(description) <= 8000)),
    CONSTRAINT products_image_url_check CHECK (((image_url IS NULL) OR (image_url ~ '^https://'::text))),
    CONSTRAINT products_instructions_check CHECK ((char_length(instructions) <= 4000)),
    CONSTRAINT products_max_quantity_per_order_check CHECK (((max_quantity_per_order >= 1) AND (max_quantity_per_order <= 20))),
    CONSTRAINT products_modality_check CHECK ((char_length(modality) <= 120)),
    CONSTRAINT products_monogram_check CHECK ((char_length(monogram) <= 4)),
    CONSTRAINT products_name_check CHECK (((char_length(btrim(name)) >= 2) AND (char_length(btrim(name)) <= 120))),
    CONSTRAINT products_period_check CHECK ((char_length(period) <= 120)),
    CONSTRAINT products_price_cents_check CHECK (((price_cents > 0) AND (price_cents <= 100000000))),
    CONSTRAINT products_short_description_check CHECK ((char_length(short_description) <= 280)),
    CONSTRAINT products_slug_check CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT products_theme_check CHECK ((theme = ANY (ARRAY['green'::text, 'red'::text, 'violet'::text, 'rose'::text, 'gray'::text, 'blue'::text, 'orange'::text])))
);

--

ALTER TABLE ONLY public.product_price_history ALTER COLUMN id SET DEFAULT nextval('public.product_price_history_id_seq'::regclass);
