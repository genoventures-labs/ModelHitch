import type { FailoverEvent } from './failover.js';

/**
 * Usage tracking for dashboards and rate-limit accounting.
 *
 * The server records every completed inference request (via `onUsage`) and
 * every auto-mode failover into a `UsageTracker`. Snapshots aggregate totals,
 * per-provider/model/wire breakdowns, and rolling windows aligned with the
 * OpenCode Go usage limits (5h = $12, 7d = $30, 30d = $60) so you can see how
 * close a bridge is to the next 429.
 */

/** One completed inference request, as reported to the `onUsage` hook. */
export interface UsageEvent {
  /** Provider id, e.g. "opencode-zen". */
  providerId: string;
  /** Routed model id. */
  model: string;
  /** Wire that served the request: chat-completions | responses | messages | gemini. */
  wire: string;
  /** True when the client requested SSE streaming. */
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated USD (best-effort list pricing; 0 for free/unknown). */
  costUsd: number;
  /** Wall time from request start to completion, ms. */
  latencyMs: number;
  /** ISO timestamp. */
  at: string;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated USD (best-effort list pricing; 0 for free/unknown). */
  costUsd: number;
  latencyMs: number;
}

export interface UsageWindow extends UsageTotals {
  /** Dollar limit for the window — the OpenCode Go usage limits. */
  capUsd: number;
  /** Fraction of the cap consumed (0..1+; >1 means the limit is passed). */
  fraction: number;
}

export interface UsageSnapshot {
  /** ISO timestamp of the first recorded event (or tracker creation). */
  since: string;
  totals: UsageTotals;
  perProvider: Record<string, UsageTotals>;
  /** Keyed by `providerId/model`. */
  perModel: Record<string, UsageTotals>;
  perWire: Record<string, UsageTotals>;
  /** Most recent events, newest first. */
  recent: UsageEvent[];
  failovers: { total: number; recent: FailoverEvent[] };
  /** Rolling windows aligned with the OpenCode Go usage limits. */
  windows: { '5h': UsageWindow; '7d': UsageWindow; '30d': UsageWindow };
}

const MAX_EVENTS = 10_000;
const MAX_FAILOVERS = 200;

export class UsageTracker {
  private events: UsageEvent[] = [];
  private failoverEvents: FailoverEvent[] = [];
  private since = new Date();

  record(event: UsageEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  recordFailover(event: FailoverEvent): void {
    this.failoverEvents.push(event);
    if (this.failoverEvents.length > MAX_FAILOVERS) {
      this.failoverEvents.splice(0, this.failoverEvents.length - MAX_FAILOVERS);
    }
  }

  reset(): void {
    this.events = [];
    this.failoverEvents = [];
    this.since = new Date();
  }

  totals(events: readonly UsageEvent[] = this.events): UsageTotals {
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let latencyMs = 0;
    for (const e of events) {
      requests += 1;
      inputTokens += e.inputTokens ?? 0;
      outputTokens += e.outputTokens ?? 0;
      totalTokens += e.totalTokens ?? 0;
      costUsd += e.costUsd ?? 0;
      latencyMs += e.latencyMs ?? 0;
    }
    return { requests, inputTokens, outputTokens, totalTokens, costUsd, latencyMs };
  }

  private group(key: (e: UsageEvent) => string): Record<string, UsageTotals> {
    const groups = new Map<string, UsageEvent[]>();
    for (const e of this.events) {
      const k = key(e);
      const list = groups.get(k);
      if (list) list.push(e);
      else groups.set(k, [e]);
    }
    const out: Record<string, UsageTotals> = {};
    for (const [k, list] of groups) out[k] = this.totals(list);
    return out;
  }

  private window(hours: number, capUsd: number): UsageWindow {
    const cutoff = Date.now() - hours * 3_600_000;
    const totals = this.totals(this.events.filter((e) => Date.parse(e.at) >= cutoff));
    return { ...totals, capUsd, fraction: capUsd > 0 ? totals.costUsd / capUsd : 0 };
  }

  snapshot(): UsageSnapshot {
    return {
      since: this.since.toISOString(),
      totals: this.totals(),
      perProvider: this.group((e) => e.providerId),
      perModel: this.group((e) => `${e.providerId}/${e.model}`),
      perWire: this.group((e) => e.wire),
      recent: this.events.slice(-50).reverse(),
      failovers: {
        total: this.failoverEvents.length,
        recent: this.failoverEvents.slice(-20).reverse(),
      },
      windows: {
        '5h': this.window(5, 12),
        '7d': this.window(168, 30),
        '30d': this.window(720, 60),
      },
    };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Self-contained dashboard served by the bridge at `GET /usage`. */
export function usageDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ModelHitch usage</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; background: #0d1117; color: #e6edf3; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b949e; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; }
  .card .k { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  .card .v { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .wins { display: grid; gap: 10px; margin-bottom: 20px; }
  .win { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; }
  .win-label { margin-bottom: 6px; }
  .bar { height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; }
  .fill { height: 100%; background: #2f81f7; border-radius: 4px; }
  .fill.over { background: #f85149; }
  .over { color: #f85149; }
  .win-sub { color: #8b949e; font-size: 12px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: none; }
  .fail { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; }
  .muted { color: #8b949e; }
  #err { color: #f85149; margin-bottom: 12px; display: none; }
</style>
</head>
<body>
  <h1>ModelHitch usage</h1>
  <div class="sub">live bridge telemetry · <span id="since">—</span> · auto-refreshes</div>
  <div id="err"></div>
  <div id="app">loading…</div>
<script>
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => '$' + Number(n).toFixed(2);
const fmtI = (n) => Math.round(n).toLocaleString('en-US');
async function tick() {
  try {
    const t = await (await fetch('/v1/usage')).json();
    document.getElementById('err').style.display = 'none';
    document.getElementById('since').textContent = 'since ' + new Date(t.since).toLocaleString();
    const winLabels = {'5h':'5 hours ($12 cap)','7d':'7 days ($30 cap)','30d':'30 days ($60 cap)'};
    const wins = Object.keys(winLabels).map((k) => {
      const w = t.windows[k];
      const over = w.fraction > 1;
      return '<div class="win"><div class="win-label">' + winLabels[k] + ' <b>' + fmt(w.costUsd) + '</b> of ' + fmt(w.capUsd) +
        ' <span class="' + (over ? 'over' : '') + '">' + Math.min(Math.round(w.fraction*100),999) + '%</span></div>' +
        '<div class="bar"><div class="fill ' + (over ? 'over' : '') + '" style="width:' + Math.min(w.fraction*100,100) + '%"></div></div>' +
        '<div class="win-sub">' + fmtI(w.requests) + ' req · ' + fmtI(w.totalTokens) + ' tok</div></div>';
    }).join('');
    const prow = Object.entries(t.perProvider).sort((a,b) => b[1].costUsd - a[1].costUsd)
      .map(([id,v]) => '<tr><td>' + esc(id) + '</td><td>' + fmtI(v.requests) + '</td><td>' + fmtI(v.inputTokens) + '/' + fmtI(v.outputTokens) + '</td><td>' + fmt(v.costUsd) + '</td></tr>').join('') ||
      '<tr><td colspan="4" class="muted">no requests yet</td></tr>';
    const mrow = Object.entries(t.perModel).sort((a,b) => b[1].costUsd - a[1].costUsd).slice(0,15)
      .map(([id,v]) => '<tr><td>' + esc(id) + '</td><td>' + fmtI(v.requests) + '</td><td>' + fmtI(v.totalTokens) + '</td><td>' + fmt(v.costUsd) + '</td></tr>').join('') ||
      '<tr><td colspan="4" class="muted">no requests yet</td></tr>';
    const fails = t.failovers.recent.length === 0
      ? '<div class="muted">no failovers yet — auto-mode is standing by</div>'
      : t.failovers.recent.map((f) => '<div class="fail">' + esc(f.from.providerId) + '/' + esc(f.from.model) + ' → <b>' + esc(f.to.providerId) + '/' + esc(f.to.model) + '</b> <span class="muted">(' + esc(f.error.code) + (f.error.status ? ' HTTP ' + f.error.status : '') + ')</span></div>').join('');
    document.getElementById('app').innerHTML =
      '<div class="cards">' +
        '<div class="card"><div class="k">Requests</div><div class="v">' + fmtI(t.totals.requests) + '</div></div>' +
        '<div class="card"><div class="k">Tokens (in/out)</div><div class="v">' + fmtI(t.totals.inputTokens) + ' / ' + fmtI(t.totals.outputTokens) + '</div></div>' +
        '<div class="card"><div class="k">Est. cost</div><div class="v">' + fmt(t.totals.costUsd) + '</div></div>' +
        '<div class="card"><div class="k">Failovers</div><div class="v">' + t.failovers.total + '</div></div>' +
      '</div>' +
      '<div class="wins">' + wins + '</div>' +
      '<table><thead><tr><th>Provider</th><th>Requests</th><th>Tokens (in/out)</th><th>Cost</th></tr></thead><tbody>' + prow + '</tbody></table>' +
      '<table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>' + mrow + '</tbody></table>' +
      '<h1>Recent failovers</h1><div style="margin-top:8px">' + fails + '</div>';
  } catch (e) {
    document.getElementById('err').style.display = 'block';
    document.getElementById('err').textContent = 'bridge unreachable: ' + e;
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}
