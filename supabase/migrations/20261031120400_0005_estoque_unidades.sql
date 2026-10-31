-- ============================================================================
-- 0005 ESTOQUE UNIDADES
-- Unidades de estoque (credenciais cifradas) e lotes de importação.
-- ============================================================================

--

CREATE TABLE public.import_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    file_name text,
    total_rows integer DEFAULT 0 NOT NULL,
    accepted_rows integer DEFAULT 0 NOT NULL,
    rejected_rows integer DEFAULT 0 NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_batches_accepted_rows_check CHECK ((accepted_rows >= 0)),
    CONSTRAINT import_batches_file_name_check CHECK (((file_name IS NULL) OR (char_length(file_name) <= 200))),
    CONSTRAINT import_batches_rejected_rows_check CHECK ((rejected_rows >= 0)),
    CONSTRAINT import_batches_total_rows_check CHECK ((total_rows >= 0))
);

--

CREATE TABLE public.stock_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    account_email_enc bytea NOT NULL,
    account_password_enc bytea NOT NULL,
    credential_fingerprint text NOT NULL,
    status public.stock_unit_status DEFAULT 'available'::public.stock_unit_status NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    import_batch_id uuid,
    sold_order_id uuid,
    sold_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT stock_units_account_email_enc_check CHECK (((octet_length(account_email_enc) >= 28) AND (octet_length(account_email_enc) <= 4096))),
    CONSTRAINT stock_units_account_password_enc_check CHECK (((octet_length(account_password_enc) >= 28) AND (octet_length(account_password_enc) <= 4096))),
    CONSTRAINT stock_units_credential_fingerprint_check CHECK ((credential_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT stock_units_notes_check CHECK ((char_length(notes) <= 500)),
    CONSTRAINT stock_units_sold_consistency CHECK ((((status = 'sold'::public.stock_unit_status) AND (sold_order_id IS NOT NULL) AND (sold_at IS NOT NULL)) OR ((status <> 'sold'::public.stock_unit_status) AND (sold_order_id IS NULL) AND (sold_at IS NULL))))
);
