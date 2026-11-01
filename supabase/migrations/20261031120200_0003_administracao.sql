-- ============================================================================
-- 0003 ADMINISTRACAO
-- Allowlist de administradores e trilha de auditoria.
-- ============================================================================

--

CREATE TABLE public.admin_audit_log (
    id bigint NOT NULL,
    actor_user_id uuid,
    actor_label text,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--

CREATE SEQUENCE public.admin_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

ALTER SEQUENCE public.admin_audit_log_id_seq OWNED BY public.admin_audit_log.id;

--

CREATE TABLE public.admin_users (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    role text DEFAULT 'admin'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    mfa_required boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT admin_users_display_name_check CHECK (((char_length(btrim(display_name)) >= 2) AND (char_length(btrim(display_name)) <= 80))),
    CONSTRAINT admin_users_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text])))
);

--

ALTER TABLE ONLY public.admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_log_id_seq'::regclass);
