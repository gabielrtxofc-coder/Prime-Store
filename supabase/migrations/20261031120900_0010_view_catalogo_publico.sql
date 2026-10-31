-- ============================================================================
-- 0010 VIEW CATALOGO PUBLICO
-- View pública do catálogo (sem custo nem credenciais).
-- ============================================================================

--

CREATE VIEW public.public_catalog AS
 SELECT p.id,
    p.slug,
    p.name,
    p.short_description,
    p.description,
    p.image_url,
    p.category_id,
    c.label AS category_label,
    p.modality,
    p.period,
    p.price_cents,
    p.access_validity_days,
    p.access_validity_label,
    p.instructions,
    p.conditions,
    p.monogram,
    p.theme,
    p.max_quantity_per_order,
    p.is_featured,
    p.created_at,
    p.updated_at,
    COALESCE(s.available_units, (0)::bigint) AS available_units,
    (COALESCE(s.available_units, (0)::bigint) > 0) AS is_available
   FROM ((public.products p
     JOIN public.product_categories c ON (((c.id = p.category_id) AND c.is_active)))
     LEFT JOIN ( SELECT stock_units.product_id,
            count(*) AS available_units
           FROM public.stock_units
          WHERE (stock_units.status = 'available'::public.stock_unit_status)
          GROUP BY stock_units.product_id) s ON ((s.product_id = p.id)))
  WHERE (p.is_active AND (p.archived_at IS NULL));
