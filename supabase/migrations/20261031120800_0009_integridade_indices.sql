-- ============================================================================
-- 0009 INTEGRIDADE INDICES
-- Chaves primárias, unicidade, índices e chaves estrangeiras.
-- ============================================================================

--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (user_id);

--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);

--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_order_id_key UNIQUE (order_id);

--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_token_hash_key UNIQUE (token_hash);

--

ALTER TABLE ONLY public.delivery_units
    ADD CONSTRAINT delivery_units_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.delivery_units
    ADD CONSTRAINT delivery_units_unique_pair UNIQUE (delivery_id, stock_unit_id);

--

ALTER TABLE ONLY public.delivery_units
    ADD CONSTRAINT delivery_units_unique_unit UNIQUE (stock_unit_id);

--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_idempotency_key_key UNIQUE (idempotency_key);

--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_reference_key UNIQUE (reference);

--

ALTER TABLE ONLY public.payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_provider_payment_id_key UNIQUE (provider_payment_id);

--

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_slug_key UNIQUE (slug);

--

ALTER TABLE ONLY public.refund_requests
    ADD CONSTRAINT refund_requests_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.stock_reservation_units
    ADD CONSTRAINT stock_reservation_units_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.stock_units
    ADD CONSTRAINT stock_units_pkey PRIMARY KEY (id);

--

ALTER TABLE ONLY public.stock_units
    ADD CONSTRAINT stock_units_unique_credential UNIQUE (product_id, credential_fingerprint);

--

CREATE INDEX admin_audit_log_actor_idx ON public.admin_audit_log USING btree (actor_user_id, created_at DESC);

--

CREATE INDEX admin_audit_log_created_idx ON public.admin_audit_log USING btree (created_at DESC);

--

CREATE INDEX admin_audit_log_entity_idx ON public.admin_audit_log USING btree (entity_type, entity_id);

--

CREATE INDEX deliveries_order_idx ON public.deliveries USING btree (order_id);

--

CREATE INDEX delivery_units_delivery_idx ON public.delivery_units USING btree (delivery_id);

--

CREATE INDEX import_batches_product_idx ON public.import_batches USING btree (product_id, created_at DESC);

--

CREATE INDEX order_events_order_idx ON public.order_events USING btree (order_id, created_at DESC);

--

CREATE INDEX orders_created_idx ON public.orders USING btree (created_at DESC);

--

CREATE INDEX orders_payment_status_idx ON public.orders USING btree (payment_status, created_at DESC);

--

CREATE INDEX orders_pending_expiry_idx ON public.orders USING btree (reservation_expires_at) WHERE (status = 'pending_payment'::public.order_status);

--

CREATE INDEX orders_product_idx ON public.orders USING btree (product_id, created_at DESC);

--

CREATE INDEX orders_status_created_idx ON public.orders USING btree (status, created_at DESC);

--

CREATE INDEX payment_events_data_idx ON public.payment_events USING btree (data_id, received_at DESC);

--

CREATE UNIQUE INDEX payment_events_notification_unique ON public.payment_events USING btree (provider, notification_id) WHERE (notification_id IS NOT NULL);

--

CREATE INDEX payment_events_status_idx ON public.payment_events USING btree (status, received_at DESC);

--

CREATE UNIQUE INDEX payments_one_open_per_order ON public.payments USING btree (order_id) WHERE (status = ANY (ARRAY['pending'::public.payment_status, 'in_process'::public.payment_status]));

--

CREATE INDEX payments_order_idx ON public.payments USING btree (order_id, created_at DESC);

--

CREATE INDEX product_price_history_product_idx ON public.product_price_history USING btree (product_id, changed_at DESC);

--

CREATE INDEX products_active_idx ON public.products USING btree (is_active) WHERE (archived_at IS NULL);

--

CREATE INDEX products_category_idx ON public.products USING btree (category_id) WHERE (archived_at IS NULL);

--

CREATE UNIQUE INDEX refund_requests_one_open_per_order ON public.refund_requests USING btree (order_id) WHERE (status = ANY (ARRAY['pending'::text, 'authorized'::text]));

--

CREATE INDEX refund_requests_status_idx ON public.refund_requests USING btree (status, created_at DESC);

--

CREATE UNIQUE INDEX stock_reservation_units_live_unique ON public.stock_reservation_units USING btree (stock_unit_id) WHERE (released_at IS NULL);

--

CREATE INDEX stock_reservation_units_reservation_idx ON public.stock_reservation_units USING btree (reservation_id) WHERE (released_at IS NULL);

--

CREATE INDEX stock_reservations_expiry_idx ON public.stock_reservations USING btree (expires_at) WHERE (status = 'active'::public.reservation_status);

--

CREATE UNIQUE INDEX stock_reservations_one_active_per_order ON public.stock_reservations USING btree (order_id) WHERE (status = 'active'::public.reservation_status);

--

CREATE INDEX stock_reservations_order_idx ON public.stock_reservations USING btree (order_id, created_at DESC);

--

CREATE INDEX stock_units_available_idx ON public.stock_units USING btree (product_id, created_at, id) WHERE (status = 'available'::public.stock_unit_status);

--

CREATE INDEX stock_units_order_idx ON public.stock_units USING btree (sold_order_id) WHERE (sold_order_id IS NOT NULL);

--

CREATE INDEX stock_units_status_idx ON public.stock_units USING btree (product_id, status);

--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.deliveries
    ADD CONSTRAINT deliveries_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.delivery_units
    ADD CONSTRAINT delivery_units_delivery_id_fkey FOREIGN KEY (delivery_id) REFERENCES public.deliveries(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.delivery_units
    ADD CONSTRAINT delivery_units_stock_unit_id_fkey FOREIGN KEY (stock_unit_id) REFERENCES public.stock_units(id) ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.order_events
    ADD CONSTRAINT order_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.refund_requests
    ADD CONSTRAINT refund_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.stock_reservation_units
    ADD CONSTRAINT stock_reservation_units_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.stock_reservation_units
    ADD CONSTRAINT stock_reservation_units_stock_unit_id_fkey FOREIGN KEY (stock_unit_id) REFERENCES public.stock_units(id) ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.stock_reservations
    ADD CONSTRAINT stock_reservations_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;

--

ALTER TABLE ONLY public.stock_units
    ADD CONSTRAINT stock_units_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batches(id) ON DELETE SET NULL;

--

ALTER TABLE ONLY public.stock_units
    ADD CONSTRAINT stock_units_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE RESTRICT;

--

ALTER TABLE ONLY public.stock_units
    ADD CONSTRAINT stock_units_sold_order_fk FOREIGN KEY (sold_order_id) REFERENCES public.orders(id) ON DELETE RESTRICT;
