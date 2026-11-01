-- ============================================================================
-- 0013 TRIGGERS
-- Gatilhos de updated_at e histórico de preços.
-- ============================================================================

--

CREATE TRIGGER admin_users_set_updated_at BEFORE UPDATE ON public.admin_users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--

CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--

CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--

CREATE TRIGGER products_price_history AFTER UPDATE OF price_cents, cost_cents ON public.products FOR EACH ROW EXECUTE FUNCTION public.products_record_price_change();

--

CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--

CREATE TRIGGER stock_units_set_updated_at BEFORE UPDATE ON public.stock_units FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
