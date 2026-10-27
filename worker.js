/* Kadr worker — Cloudflare Workers + KV + Cron
 *
 * Что делает:
 *   POST /sub   — приложение присылает список тайтлов с колокольчиком, воркер шлёт сообщение, когда серия вышла
 *   POST /pub   — публикует (или удаляет) снимок списка для друзей
 *   GET  /p/:id — отдаёт снимок списка друга
 *
 * Настройка (5 минут):
 *   1. Cloudflare → Workers & Pages → Create → Worker, вставь этот файл.
 *   2. Storage & Databases → KV → создай namespace, в Worker → Settings → Bindings добавь KV с именем KADR.
 *   3. Settings → Variables and Secrets:
 *        BOT_TOKEN (secret) — токен бота от @BotFather (того же бота, в котором мини-апп)
 *        APP_URL   (text)   — https-адрес приложения, например https://wyxxss.github.io/kadr/
 *        TMDB_KEY  (text, необязательно) — чтобы воркер сам узнавал следующую серию у сериалов
 *   4. Settings → Triggers → Cron Triggers → добавь  */10 * * * *
 *   5. Адрес воркера впиши в config.js:  window.CFG = { TMDB:'...', API:'https://kadr.<имя>.workers.dev', BOT:'botusername/appshortname' }
 *
 * Важно: бот сможет писать пользователю, только если тот запускал бота (приложение само спросит разрешение).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
const enc = new TextEncoder();
const HOUR = 3600e3, DAY = 24 * HOUR;

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// Проверка подписи initData от Telegram. Возвращает id пользователя или null.
async function auth(initData, env) {
  const p = new URLSearchParams(initData || '');
  const h = p.get('hash');
  if (!h || !env.BOT_TOKEN) return null;
  p.delete('hash');
  const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = await hmac(enc.encode('WebAppData'), env.BOT_TOKEN);
  if (hex(await hmac(secret, check)) !== h) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 3 * 86400) return null;
  try { return JSON.parse(p.get('user')).id; } catch { return null; }
}

const clean = s => String(s || '').slice(0, 120);

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    try {
      if (req.method === 'GET' && u.pathname.startsWith('/p/')) {
        const id = u.pathname.slice(3).replace(/\D/g, '');
        const v = id && await env.KADR.get('p:' + id);
        return v ? new Response(v, { headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'max-age=30' } }) : J({}, 404);
      }
      if (req.method === 'POST') {
        const b = await req.json();
        const uid = await auth(b.initData, env);
        if (!uid) return J({ error: 'auth' }, 401);

        if (u.pathname === '/sub') {
          const subs = (Array.isArray(b.subs) ? b.subs : []).slice(0, 60).map(s => ({
            id: clean(s.id), n: clean(s.n), at: +s.at || 0, ep: +s.ep || 0, se: +s.se || 0, z: +s.z || 0
          })).filter(s => s.id && s.at);
          if (subs.length) await env.KADR.put('s:' + uid, JSON.stringify(subs), { expirationTtl: 60 * 86400 });
          else await env.KADR.delete('s:' + uid);
          return J({ ok: 1 });
        }
        if (u.pathname === '/pub') {
          if (b.on && b.snap) {
            const v = JSON.stringify(b.snap);
            if (v.length > 20000) return J({ error: 'big' }, 413);
            await env.KADR.put('p:' + uid, v, { expirationTtl: 120 * 86400 });
          } else await env.KADR.delete('p:' + uid);
          return J({ ok: 1 });
        }
      }
    } catch (e) {
      return J({ error: String(e) }, 500);
    }
    return J({ ok: 1, name: 'kadr' });
  },

  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(tick(env));
  }
};

async function tg(env, uid, s) {
  const ep = s.se ? `S${s.se} · E${s.ep}` : `серия ${s.ep}`;
  const body = { chat_id: uid, text: `🎬 Вышла ${ep}\n${s.n}` };
  if (env.APP_URL) body.reply_markup = { inline_keyboard: [[{ text: 'Открыть Kadr', web_app: { url: env.APP_URL } }]] };
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

// Узнаём следующую серию для тайтла, у которого вышла предыдущая.
async function nextOf(env, s) {
  try {
    const n = s.id.slice(1);
    if (s.id[0] === 'a') {
      const r = await fetch(`https://shikimori.one/api/animes/${n}`, { headers: { 'User-Agent': 'kadr-worker' } });
      const d = await r.json();
      if (d.next_episode_at) return { at: Date.parse(d.next_episode_at), ep: (d.episodes_aired || 0) + 1, se: 0 };
    } else if (env.TMDB_KEY) {
      const r = await fetch(`https://api.themoviedb.org/3/tv/${n}?api_key=${env.TMDB_KEY}`);
      const d = await r.json();
      const x = d.next_episode_to_air;
      if (x && x.air_date) {
        const [y, m, dd] = x.air_date.split('-').map(Number);
        // у TMDB только дата выхода, поэтому уведомляем в 10:00 по времени пользователя
        return { at: Date.UTC(y, m - 1, dd, 10) + (s.z || 0) * 60000, ep: x.episode_number, se: s.se ? x.season_number : 0 };
      }
    }
  } catch { /* сеть, попробуем в следующий раз */ }
  return null;
}

async function tick(env) {
  const now = Date.now();
  let cursor;
  do {
    const page = await env.KADR.list({ prefix: 's:', cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const uid = k.name.slice(2);
      let subs;
      try { subs = JSON.parse(await env.KADR.get(k.name) || '[]'); } catch { subs = []; }
      let changed = false;
      for (const s of subs) {
        // пора отправлять: срок наступил, ещё не отправляли эту серию, не позже 36 часов назад
        if (s.at <= now && s.sent !== s.ep && now - s.at < 36 * HOUR) {
          try { await tg(env, uid, s); } catch { continue; }
          s.sent = s.ep; s.chk = 0; changed = true;
        }
        // отправили (или проспали) — ищем следующую серию раз в час
        if (s.at <= now && (s.sent === s.ep || now - s.at >= 36 * HOUR) && now - (s.chk || 0) > HOUR) {
          s.chk = now; changed = true;
          const nx = await nextOf(env, s);
          if (nx && nx.ep > s.ep) { s.at = nx.at; s.ep = nx.ep; s.se = nx.se; delete s.sent; }
        }
      }
      const live = subs.filter(s => now - s.at < 30 * DAY);
      if (changed || live.length !== subs.length) {
        if (live.length) await env.KADR.put(k.name, JSON.stringify(live), { expirationTtl: 60 * 86400 });
        else await env.KADR.delete(k.name);
      }
    }
  } while (cursor);
}
