-- ============================================================================
-- DADOS INICIAIS (idempotentes)
-- ============================================================================
-- Apenas categorias do catálogo e parâmetros operacionais. Nenhum produto,
-- credencial, pedido ou valor comercial é inserido aqui: a loja começa vazia
-- e os produtos são cadastrados pelo painel administrativo.

insert into public.app_settings (key, value, description) values
  ('reservation_minutes', '30'::jsonb, 'Duração da reserva interna de estoque, em minutos.'),
  ('pix_expiry_minutes', '30'::jsonb, 'Validade do PIX (mínimo aceito pelo Mercado Pago), em minutos.'),
  ('max_quantity_per_order', '20'::jsonb, 'Teto absoluto de unidades por pedido na V1.')
on conflict (key) do update
  set value = excluded.value,
      description = excluded.description;

insert into public.product_categories (id, label, description, sort_order) values
  ('music', 'Música', 'Referências de áudio e música', 10),
  ('film-series', 'Filmes e séries', 'Referências de entretenimento', 20),
  ('creative', 'Design e criatividade', 'Ferramentas e recursos criativos', 30),
  ('productivity', 'Produtividade', 'Organização e foco', 40),
  ('other', 'Outras categorias digitais', 'Outros itens digitais', 50)
on conflict (id) do update
  set label = excluded.label,
      description = excluded.description,
      sort_order = excluded.sort_order;
