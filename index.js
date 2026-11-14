// Host half of dsh-cost-meter.
//
// The client projection `tokenUsage` only carries cumulative token counts, so the
// meter had to price the whole history at "now" — every peak/off-peak boundary or
// page reload rewrote past amounts. This route exposes a per-step ledger built
// from the session's own event stream, where each step is priced with the model
// and peak/off-peak rate that were in force when the request started.
//
//   GET /api/cost-meter/ledger?id=<sessionId>  -> { ok:true, sessionId, seq, steps, totals, turns, ... }
//
// Requires the panel header `x-cost-meter: 1` (same anti-accident convention as
// the other local plugins). Read-only: it never writes, mutates or replays.
import { buildLedger } from './lib/ledger.mjs';

export const name = 'dsh-cost-meter';
export const inject = ['webServer', 'sessions'];

const LEDGER_PATH = '/api/cost-meter/ledger';
const PANEL_HEADER = 'x-cost-meter';
const MAX_CACHED_SESSIONS = 32;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export function apply(ctx) {
  const logger = ctx && ctx.logger;

  // 会话 id 在存储里带 `session-` 前缀（SessionHeader.id = "session-<uuid>"），
  // 但调用方可能只拿到裸 uuid；两种写法都试一次，避免查不到而静默退回按现价折算。
  const findSession = (raw) => {
    if (!raw || typeof ctx.sessions?.get !== 'function') return undefined;
    const candidates = raw.startsWith('session-') ? [raw, raw.slice('session-'.length)] : [raw, `session-${raw}`];
    for (const candidate of candidates) {
      try {
        const session = ctx.sessions.get(candidate);
        if (session) return session;
      } catch (_) {
        // 继续试下一种写法
      }
    }
    return undefined;
  };

  // seq → 账本：同一会话在 seq 没变时事件流必然相同，直接复用，避免每一步都重算。
  const memo = new Map();

  const handler = async (req, res) => {
    if (req.headers[PANEL_HEADER] !== '1') return json(res, 403, { ok: false, error: 'missing panel header' });
    const id = (() => {
      try {
        return new URL(req.url || LEDGER_PATH, 'http://localhost').searchParams.get('id') || '';
      } catch (_) {
        return '';
      }
    })();
    if (!id) return json(res, 400, { ok: false, reason: 'missing-id' });
    try {
      const session = findSession(id);
      if (!session) return json(res, 200, { ok: false, reason: 'not-live', sessionId: id });

      const seq = Number(session.seq) || 0;
      const hit = memo.get(id);
      if (hit && hit.seq === seq) return json(res, 200, hit.body);

      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
      const body = { ok: true, sessionId: id, seq, ...buildLedger(events) };

      memo.set(id, { seq, body });
      if (memo.size > MAX_CACHED_SESSIONS) {
        for (const key of memo.keys()) {
          if (key === id) continue;
          memo.delete(key);
          break;
        }
      }
      json(res, 200, body);
    } catch (error) {
      logger?.error?.(`[cost-meter] ledger 失败：${messageOf(error)}`);
      json(res, 500, { ok: false, reason: 'error', error: messageOf(error) });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: LEDGER_PATH, handler }),
    'cost-meter: ledger route',
  );
}
