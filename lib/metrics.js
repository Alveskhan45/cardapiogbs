// @ts-check
/* ============================================================
   lib/metrics.js — métricas em memória do processo

   Escopo: UMA instância. Não é substituto de Prometheus/Grafana;
   é o suficiente para responder "quantos 5xx? qual rota? qual
   latência?" sem depender de infraestrutura externa.

   Deliberadamente sem lock: Node é single-threaded e os counters
   são inteiros/arrays simples — sem condição de corrida.
   ============================================================ */
'use strict';

/** @type {{ requests: number, errors: number, by_status: Record<string, number>, by_route: Record<string, { count: number, errors: number, total_ms: number, max_ms: number }>, started_at: number }} */
const state = {
  requests: 0,
  errors: 0,
  by_status: {},
  by_route: {},
  started_at: Date.now()
};

/* Amostras de latência (ms) em janela deslizante: 2000 é o bastante
   para percentis estáveis e ocupa pouca memória. */
const LATENCY_WINDOW = 2000;
/** @type {number[]} */
const latency = [];

/**
 * Registra uma requisição concluída.
 * @param {{ status: number, route: string, duration_ms: number, error?: boolean }} sample
 */
function observe(sample) {
  state.requests += 1;
  const cls = `${Math.floor(sample.status / 100)}xx`;
  state.by_status[cls] = (state.by_status[cls] || 0) + 1;
  const routeKey = String(sample.route || 'UNKNOWN').slice(0, 120);
  const prev = state.by_route[routeKey] || { count: 0, errors: 0, total_ms: 0, max_ms: 0 };
  prev.count += 1;
  prev.total_ms += Number(sample.duration_ms) || 0;
  prev.max_ms = Math.max(prev.max_ms, Number(sample.duration_ms) || 0);
  if (sample.error) prev.errors += 1;
  state.by_route[routeKey] = prev;

  latency.push(Number(sample.duration_ms) || 0);
  if (latency.length > LATENCY_WINDOW) latency.shift();

  if (sample.status >= 500) state.errors += 1;
}

/** @param {number} p percentil 0..100 @returns {number} */
function percentile(p) {
  if (!latency.length) return 0;
  const sorted = [...latency].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Snapshot para o painel. */
function snapshot() {
  const uptime_s = Math.floor((Date.now() - state.started_at) / 1000);
  const errorRate = state.requests ? Number(((state.errors / state.requests) * 100).toFixed(2)) : 0;
  const routes = Object.entries(state.by_route)
    .map(([route, r]) => ({
      route,
      count: r.count,
      errors: r.errors,
      avg_ms: Math.round(r.total_ms / r.count),
      max_ms: r.max_ms
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    uptime_s,
    requests_total: state.requests,
    errors_5xx_total: state.errors,
    error_rate_pct: errorRate,
    by_status_class: { ...state.by_status },
    latency_ms: { p50: percentile(50), p95: percentile(95), p99: percentile(99), samples: latency.length },
    top_routes: routes
  };
}

/** Zera os contadores (usado em teste). */
function reset() {
  state.requests = 0;
  state.errors = 0;
  state.by_status = {};
  state.by_route = {};
  state.started_at = Date.now();
  latency.length = 0;
}

module.exports = { observe, snapshot, percentile, reset };
