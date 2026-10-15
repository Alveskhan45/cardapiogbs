-- Migração: tabela de eventos de webhook (idempotência)
CREATE TABLE IF NOT EXISTS public.webhook_events (
    idempotency_key TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider ON public.webhook_events (provider);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON public.webhook_events (created_at);

-- Comentários
COMMENT ON TABLE public.webhook_events IS 'Registro de eventos de webhook processados (idempotência)';
COMMENT ON COLUMN public.webhook_events.idempotency_key IS 'Chave única do evento (provider + event.id)';
COMMENT ON COLUMN public.webhook_events.provider IS 'Provedor (stripe, asaas)';
COMMENT ON COLUMN public.webhook_events.event_type IS 'Tipo do evento (ex.: invoice.payment_succeeded)';
COMMENT ON COLUMN public.webhook_events.payload IS 'Payload completo do evento para auditoria';