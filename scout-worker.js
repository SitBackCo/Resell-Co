// ═══════════════════════════════════════════════════════════════════════
// RESELL & CO — SCOUT AGENT WORKER
// Watches eBay UK (Browse API) AND Gumtree (public RSS), scores every hit with the
// Opportunity Score, stores finds ≥ threshold in KV. Runs hourly on a cron + on demand.
//
// SETUP (Cloudflare dashboard):
//   Bindings  → KV namespace, variable name: SCOUT_KV
//   Variables → SYNC_SECRET (your passphrase), EBAY_APP_ID, EBAY_CERT_ID  (free eBay developer account)
//               VAPID_PUBLIC, VAPID_PRIVATE (push keys — see README), VAPID_SUBJECT (mailto:you@email)
//   Triggers  → Cron: */10 * * * *   (every 10 minutes)
// ═══════════════════════════════════════════════════════════════════════
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'content-type,x-sync-key' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });

const CATS = { // days-to-sell, demand(1-5), default delivery £, resale fee % when reselling on eBay
  'Electronics': { days: 5, demand: 5, del: 4 }, 'Gaming': { days: 6, demand: 4, del: 4 }, 'Tools & DIY': { days: 9, demand: 4, del: 6 },
  'Fashion & Trainers': { days: 9, demand: 4, del: 4 }, 'Bikes & Sport': { days: 8, demand: 4, del: 15 }, 'Appliances': { days: 10, demand: 3, del: 20 },
  'Collectibles': { days: 18, demand: 3, del: 4 }, 'Baby & Kids': { days: 7, demand: 4, del: 6 }, 'Home & Garden': { days: 12, demand: 3, del: 10 },
  'Sofas & Furniture': { days: 14, demand: 3, del: 30 }, 'Other': { days: 12, demand: 3, del: 6 }
};

function score(buy, sell, catName, minMargin, resaleFeePct, compsCount) {
  const cat = CATS[catName] || CATS.Other;
  const fee = (resaleFeePct || 13) / 100;
  const net = sell * (1 - fee) - cat.del;
  const profit = net - buy;
  const margin = net > 0 ? profit / net : 0, roi = buy > 0 ? profit / buy : 0;
  const days = Math.round(cat.days * (6 - cat.demand) / 3);
  let s = Math.max(0, Math.min(1, margin / .55)) * 25 + Math.max(0, Math.min(1, roi)) * 20 + Math.max(0, Math.min(1, 1 - (days - 3) / 25)) * 20 + (cat.demand / 5) * 15 + .6 * 10 + (.85 * 6 + (compsCount >= 3 ? 4 : compsCount ? 2 : 0));
  s = Math.round(s); if (profit <= 0) s = Math.min(s, 25);
  return { score: s, profit: Math.round(profit), margin, roi, days, maxBuy: Math.round(net - (minMargin || 80)) };
}

async function ebayToken(env) {
  const cached = await env.SCOUT_KV.get('ebay_token', 'json');
  if (cached && cached.exp > Date.now() + 60000) return cached.tok;
  const basic = btoa(env.EBAY_APP_ID + ':' + env.EBAY_CERT_ID);
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + basic }, body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope') });
  if (!r.ok) throw new Error('eBay token failed ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  await env.SCOUT_KV.put('ebay_token', JSON.stringify({ tok: d.access_token, exp: Date.now() + (d.expires_in || 7200) * 1000 }));
  return d.access_token;
}

async function searchEbay(env, w) {
  const tok = await ebayToken(env);
  const filters = ['priceCurrency:GBP', 'price:[..' + (w.maxPrice || 9999) + ']', 'buyingOptions:{FIXED_PRICE|BEST_OFFER}'];
  if (w.condition === 'new') filters.push('conditions:{NEW}'); else if (w.condition === 'used') filters.push('conditions:{USED}');
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + encodeURIComponent(w.q) + '&filter=' + encodeURIComponent(filters.join(',')) + '&sort=newlyListed&limit=50';
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + tok, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB', 'Accept-Language': 'en-GB' } });
  if (!r.ok) throw new Error('Browse failed ' + r.status);
  const d = await r.json();
  return (d.itemSummaries || []).map(i => ({ id: i.itemId, title: i.title, price: parseFloat((i.price || {}).value || 0), url: i.itemWebUrl, img: (i.image || {}).imageUrl || '', condition: i.condition || '', location: ((i.itemLocation || {}).city || '') , ends: i.itemEndDate || '', listed: i.itemCreationDate || '' }));
}


// ─── GUMTREE: public RSS on any search URL (no API key, no auth) ───
function gumtreeURL(w) {
  const p = new URLSearchParams();
  p.set('q', w.q || '');
  p.set('search_category', 'all');
  if (w.postcode) p.set('search_location', w.postcode);
  if (w.distance) p.set('distance', String(w.distance));
  if (w.maxPrice) p.set('max_price', String(w.maxPrice));
  if (w.minPrice) p.set('min_price', String(w.minPrice));
  p.set('sort', 'date');
  return 'https://www.gumtree.com/search?' + p.toString();
}

function parseRSS(xml) {
  const out = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const chunk of items.slice(0, 40)) {
    const body = chunk.split(/<\/item>/i)[0];
    const pick = (tag) => {
      const m = body.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
    };
    const title = pick('title'), link = pick('link'), desc = pick('description'), date = pick('pubDate');
    if (!title || !link) continue;
    const pm = (title + ' ' + desc).match(/£\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/);
    const price = pm ? parseFloat(pm[1].replace(/,/g, '')) : 0;
    const im = desc.match(/<img[^>]+src=["']([^"']+)["']/i) || body.match(/<media:content[^>]+url=["']([^"']+)["']/i);
    const loc = (desc.match(/(?:Location|in)\s*[:\-]?\s*([A-Za-z\s]{3,30})/) || [])[1] || '';
    out.push({
      id: 'gt_' + link.split('/').filter(Boolean).pop(),
      title, price, url: link, img: im ? im[1] : '',
      condition: '', location: loc.trim(), listed: date, source: 'gumtree'
    });
  }
  return out;
}

async function searchGumtree(w) {
  const rss = gumtreeURL(w) + '&format=rss';
  const r = await fetch(rss, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; ResellCoScout/1.0)', accept: 'application/rss+xml,application/xml,text/xml' } });
  if (!r.ok) throw new Error('Gumtree ' + r.status);
  const xml = await r.text();
  if (!/<item>/i.test(xml)) return [];
  return parseRSS(xml);
}


// ═══════════ WEB PUSH (VAPID + aes128gcm) — no external libs ═══════════
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
};
const te = new TextEncoder();
function concat(...arrs) { const l = arrs.reduce((a, b) => a + b.length, 0); const o = new Uint8Array(l); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; }
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
async function hkdf(salt, ikm, info, len) { const prk = await hmac(salt, ikm); const t = await hmac(prk, concat(info, new Uint8Array([1]))); return t.slice(0, len); }

async function vapidJWT(env, audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(te.encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:you@example.com' })));
  const pubRaw = b64u.dec(env.VAPID_PUBLIC);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.enc(pubRaw.slice(1, 33)), y: b64u.enc(pubRaw.slice(33, 65)), d: env.VAPID_PRIVATE };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(header + '.' + body)));
  return header + '.' + body + '.' + b64u.enc(sig);
}

async function encryptPayload(sub, payloadStr) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(auth, shared, concat(te.encode('WebPush: info\0'), uaPub, localPub), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = concat(te.encode(payloadStr), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]);
  const header = concat(salt, rs, new Uint8Array([localPub.length]), localPub);
  return concat(header, cipher);
}

async function sendPush(env, sub, data) {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) throw new Error('VAPID keys not set');
  const url = new URL(sub.endpoint);
  const jwt = await vapidJWT(env, url.origin);
  const body = await encryptPayload(sub, JSON.stringify(data));
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '86400', Urgency: data.hot ? 'high' : 'normal', Authorization: 'vapid t=' + jwt + ', k=' + env.VAPID_PUBLIC }, body });
  return r.status;
}

async function broadcast(env, data) {
  const subs = (await env.SCOUT_KV.get('subs', 'json')) || [];
  let sent = 0; const keep = [];
  for (const s of subs) {
    try { const st = await sendPush(env, s.sub, data); if (st === 404 || st === 410) continue; keep.push(s); if (st >= 200 && st < 300) sent++; }
    catch (e) { keep.push(s); }
  }
  if (keep.length !== subs.length) await env.SCOUT_KV.put('subs', JSON.stringify(keep));
  return sent;
}

// morning nudge + target pings, once per day each, London time
async function dailyPushes(env) {
  const now = new Date(); const lon = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
  const day = lon.toISOString().slice(0, 10); const hour = lon.getHours();
  const state = (await env.SCOUT_KV.get('pushstate', 'json')) || {};
  const finds = (await env.SCOUT_KV.get('finds', 'json')) || [];
  const settings = (await env.SCOUT_KV.get('settings', 'json')) || {};
  let did = false;
  if (hour >= 8 && state.morning !== day) {
    const fresh = finds.filter(f => Date.now() - f.found < 864e5);
    const hot = fresh.filter(f => f.score >= 75).length;
    const lines = ['💷 Rest, resell, repeat. What are you flipping today?', '⚡ 15 messages today. Deals come from volume.', '🔍 Somebody is giving away exactly what you want. Go find it.', '📡 Radar is live. Your next flip is already listed somewhere.', '🔥 Consistency beats intensity. One listing at a time.'];
    const body = (fresh.length ? fresh.length + ' new match' + (fresh.length === 1 ? '' : 'es') + (hot ? ', ' + hot + ' high-ego' : '') + ' waiting. ' : '') + lines[lon.getDate() % lines.length];
    await broadcast(env, { title: 'Resell & Co — morning brief', body, tag: 'rc-morning', url: './' });
    state.morning = day; did = true;
  }
  if (hour >= 19 && state.evening !== day) {
    await broadcast(env, { title: 'Resell & Co — evening check', body: 'Log today\'s messages and any sales. Streaks are built at night.', tag: 'rc-evening', url: './' });
    state.evening = day; did = true;
  }
  // night-before collection reminder (19:00 London) when tomorrow is a travel day with pickups
  try {
    const pk = (await env.SCOUT_KV.get('pickups', 'json')) || { days: [0, 3], pickups: [] };
    const tomorrow = new Date(lon.getTime() + 864e5); const tday = tomorrow.getDay();
    const tkey = tomorrow.getFullYear() + '-' + String(tomorrow.getMonth() + 1).padStart(2, '0') + '-' + String(tomorrow.getDate()).padStart(2, '0');
    if (hour >= 19 && (pk.days || []).includes(tday) && state.pickup !== tkey) {
      const mine = (pk.pickups || []).filter(p => p.day === tkey);
      if (mine.length) {
        const areas = [...new Set(mine.map(p => p.area).filter(Boolean))];
        await broadcast(env, { title: '🚆 ' + mine.length + ' pickup' + (mine.length === 1 ? '' : 's') + ' tomorrow', body: mine.map(p => p.name).slice(0, 3).join(' · ') + (areas.length ? '\n' + areas.join(' → ') : '') + '\nMessage sellers tonight to confirm.', tag: 'rc-pickup', url: './', sticky: true });
        state.pickup = tkey; did = true;
      }
    }
  } catch (e) {}
  if (did) await env.SCOUT_KV.put('pushstate', JSON.stringify(state));
}


// ═══════════ INBOX — share any listing URL from anywhere → scored → pushed ═══════════
function pick(html, re){ const m = html.match(re); return m ? m[1].replace(/&amp;/g,'&').replace(/&#39;|&#x27;/g,"'").replace(/&quot;/g,'"').replace(/<[^>]+>/g,'').trim() : ''; }
function extractListing(html, url) {
  const title = pick(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || pick(html, /<title>([^<]+)<\/title>/i) || '';
  let priceStr = pick(html, /<meta[^>]+property=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([^"']+)/i)
    || pick(html, /"price"\s*:\s*"?([0-9][0-9,]*\.?[0-9]*)/i) || pick(html, /itemprop=["']price["'][^>]*content=["']([^"']+)/i);
  if (!priceStr) { const m = (title + ' ' + html.slice(0, 200000)).match(/£\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/); if (m) priceStr = m[1]; }
  const price = parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || 0;
  const desc = pick(html, /<meta[^>]+(?:property=["']og:description["']|name=["']description["'])[^>]+content=["']([^"']+)/i);
  const img = pick(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i);
  const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
  const source = /facebook/.test(host) ? 'facebook' : /gumtree/.test(host) ? 'gumtree' : /ebay/.test(host) ? 'ebay' : /vinted/.test(host) ? 'vinted' : /shpock/.test(host) ? 'shpock' : host;
  return { title, price, desc, img, source, url };
}
function matchWatch(item, watch) {
  const text = (item.title + ' ' + item.desc).toLowerCase();
  for (const w of watch) {
    const words = String(w.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || !words.every(x => text.includes(x))) continue;
    if ((w.exclude || []).some(x => text.includes(String(x).toLowerCase()))) continue;
    if (w.must && w.must.length && !w.must.some(x => text.includes(String(x).toLowerCase()))) continue;
    if (w.maxPrice && item.price > w.maxPrice) continue;
    return w;
  }
  return null;
}
async function handleInbox(env, url) {
  const watch = (await env.SCOUT_KV.get('watchlist', 'json')) || [];
  const settings = (await env.SCOUT_KV.get('settings', 'json')) || {};
  let html = '';
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', accept: 'text/html,*/*' }, redirect: 'follow' });
    html = await r.text();
  } catch (e) { html = ''; }
  const item = extractListing(html, url);
  const readable = !!(item.title && item.price);
  const w = readable ? matchWatch(item, watch) : null;
  let result;
  if (!readable) {
    result = { ok: false, reason: 'unreadable', item };
    await broadcast(env, { title: '🔗 Listing received — couldn\'t read it', body: (item.source === 'facebook' ? 'Facebook blocks readers. ' : '') + 'Open Resell & Co → Analyse → paste it to score manually.', tag: 'rc-inbox', url: './' });
  } else if (!w) {
    result = { ok: true, matched: false, item };
    await broadcast(env, { title: '🔗 ' + String(item.title).slice(0, 48), body: '£' + item.price + ' · no criteria match. Add a watch in 🎯 Criteria to auto-score items like this.', tag: 'rc-inbox', url: url });
  } else {
    const sell = parseFloat(w.sell) || 0;
    const sc = sell ? score(item.price, sell, w.category || 'Other', settings.minMargin || w.minProfit || 80, settings.resaleFee || 13, 0) : { score: 0, profit: 0, maxBuy: 0, days: 0 };
    const verdict = !sell ? 'ADD A SELLS-FOR PRICE' : sc.profit >= (w.minProfit || settings.minMargin || 80) ? (sc.score >= 75 ? 'BUY' : 'GOOD') : sc.profit > 0 ? 'LOWBALL' : 'PASS';
    const find = { id: 'in_' + Date.now(), ...item, q: w.q, category: w.category || 'Other', platform: item.source, sell, ...sc, verdict, found: Date.now(), viaInbox: true };
    const finds = (await env.SCOUT_KV.get('finds', 'json')) || [];
    finds.unshift(find); await env.SCOUT_KV.put('finds', JSON.stringify(finds.slice(0, 200)));
    result = { ok: true, matched: true, find };
    const hot = verdict === 'BUY';
    await broadcast(env, {
      title: (hot ? '🔥 ' : verdict === 'PASS' ? '⛔ ' : '📊 ') + verdict + ' · ' + (sc.profit >= 0 ? '+' : '') + '£' + sc.profit + ' est. profit',
      body: String(item.title).slice(0, 60) + '\n£' + item.price + ' → sells ~£' + sell + ' · max buy £' + sc.maxBuy + ' · ~' + sc.days + ' days · score ' + sc.score,
      tag: 'rc-inbox', url: url, hot, sticky: hot
    });
  }
  return result;
}

async function runScout(env) {
  const watch = (await env.SCOUT_KV.get('watchlist', 'json')) || [];
  const settings = (await env.SCOUT_KV.get('settings', 'json')) || { minMargin: 80, threshold: 60, resaleFee: 13 };
  const finds = (await env.SCOUT_KV.get('finds', 'json')) || [];
  const seen = new Set(finds.map(f => f.id));
  let scanned = 0, added = 0, errors = [];
  for (const w of watch) {
    if (!w.q || !w.sell) continue;
    try {
      let items = [];
      const plat = w.platform || 'ebay';
      if (plat === 'gumtree') {
        try { items = await searchGumtree(w); } catch (e) { errors.push('gumtree ' + w.q + ': ' + e.message); }
      } else if (plat === 'all') {
        try { items = await searchEbay(env, w); } catch (e) { errors.push('ebay ' + w.q + ': ' + e.message); }
        try { items = items.concat(await searchGumtree(w)); } catch (e) { errors.push('gumtree ' + w.q + ': ' + e.message); }
      } else {
        items = await searchEbay(env, w);
      }
      scanned += items.length;
      for (const it of items) {
        if (!it.price || seen.has(it.id)) continue;
        // skip titles that clearly aren't the thing (parts, broken, faulty) unless watch says otherwise
        if (!w.allowFaulty && /\b(faulty|spares|repair|broken|for parts|not working|read desc)\b/i.test(it.title)) continue;
        const tl = it.title.toLowerCase();
        if (Array.isArray(w.exclude) && w.exclude.some(x => x && tl.includes(x))) continue;          // criteria: exclude words
        if (Array.isArray(w.must) && w.must.length && !w.must.some(x => x && tl.includes(x))) continue; // criteria: must include ANY
        const sc = score(it.price, parseFloat(w.sell), w.category || 'Other', settings.minMargin, settings.resaleFee, w.compsCount || 0);
        if (sc.profit < (w.minProfit != null ? w.minProfit : (settings.minMargin || 80))) continue;      // criteria: min profit
        if (sc.score >= (settings.threshold || 60)) {
          finds.unshift({ ...it, q: w.q, category: w.category || 'Other', platform: it.source || w.platform || 'ebay', sell: parseFloat(w.sell), ...sc, found: Date.now() });
          seen.add(it.id); added++;
        }
      }
    } catch (e) { errors.push(w.q + ': ' + e.message); }
  }
  const cutoff = Date.now() - 7 * 864e5;
  const kept = finds.filter(f => f.found > cutoff).slice(0, 200);
  await env.SCOUT_KV.put('finds', JSON.stringify(kept));
  const run = { at: new Date().toISOString(), scanned, added, watch: watch.length, errors };
  await env.SCOUT_KV.put('lastrun', JSON.stringify(run));
  if (added > 0) {
    const fresh = kept.slice(0, added);
    const hot = fresh.filter(f => f.score >= 75);
    const top = hot[0] || fresh[0];
    try {
      run.pushed = await broadcast(env, {
        title: (hot.length ? '🔥 HIGH-EGO FIND' : '🛰️ New match') + ' · +£' + top.profit,
        body: String(top.title).slice(0, 70) + ' · £' + top.price + ' on ' + (top.platform || 'ebay') + (added > 1 ? ' (+' + (added - 1) + ' more)' : ''),
        tag: 'rc-find', url: top.url, hot: hot.length > 0, sticky: hot.length > 0
      });
    } catch (e) { errors.push('push: ' + e.message); }
  }
  try { await dailyPushes(env); } catch (e) { errors.push('daily: ' + e.message); }
  return run;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runScout(env)); },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/in' && request.method === 'GET') {
      const k = url.searchParams.get('k'); const u = url.searchParams.get('u');
      if (!k || k !== env.SYNC_SECRET) return json({ error: 'bad key' }, 401);
      if (!u || !/^https?:\/\//i.test(u)) return json({ error: 'u required' }, 400);
      const res = await handleInbox(env, u);
      return new Response('<!doctype html><meta name=viewport content="width=device-width"><body style="font:600 16px system-ui;padding:24px;background:#FAF8F6;color:#2a1a20"><h2 style="color:#9B1B3F">Resell &amp; Co</h2>' + (res.matched ? '<p>✅ Scored and sent to your phone.<br><b>' + (res.find.verdict) + '</b> · £' + res.find.profit + ' est. profit</p>' : res.ok ? '<p>📥 Received. No criteria matched — add a watch in the app.</p>' : '<p>⚠ Couldn\'t read that page. Paste it in Analyse instead.</p>') + '<p><a href="https://sitbackco.github.io/Sitback-Co/">Open the app →</a></p></body>', { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/ping') return json({ ok: true, service: 'resellco-scout', v: '2026-09-14.1', hasEbay: !!(env.EBAY_APP_ID && env.EBAY_CERT_ID), hasPush: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE), platforms: ['ebay', 'gumtree'], inbox: true });
    if ((request.headers.get('x-sync-key') || '') !== env.SYNC_SECRET) return json({ error: 'unauthorised' }, 401);

    if (url.pathname === '/watchlist' && request.method === 'GET') return json({ watchlist: (await env.SCOUT_KV.get('watchlist', 'json')) || [], settings: (await env.SCOUT_KV.get('settings', 'json')) || null });
    if (url.pathname === '/watchlist' && request.method === 'PUT') {
      const b = await request.json();
      if (Array.isArray(b.watchlist)) await env.SCOUT_KV.put('watchlist', JSON.stringify(b.watchlist.slice(0, 40)));
      if (b.settings) await env.SCOUT_KV.put('settings', JSON.stringify(b.settings));
      return json({ ok: true });
    }
    if (url.pathname === '/finds') return json({ finds: (await env.SCOUT_KV.get('finds', 'json')) || [], lastrun: (await env.SCOUT_KV.get('lastrun', 'json')) || null });
    if (url.pathname === '/finds/dismiss' && request.method === 'POST') {
      const { id } = await request.json();
      const finds = ((await env.SCOUT_KV.get('finds', 'json')) || []).filter(f => f.id !== id);
      await env.SCOUT_KV.put('finds', JSON.stringify(finds)); return json({ ok: true, remaining: finds.length });
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const wl0 = (await env.SCOUT_KV.get('watchlist', 'json')) || [];
      const needsEbay = wl0.some(x => (x.platform || 'ebay') !== 'gumtree');
      if (needsEbay && !env.EBAY_APP_ID) return json({ error: 'EBAY_APP_ID / EBAY_CERT_ID not set — Gumtree-only watches still work' }, 400);
      return json(await runScout(env));
    }
    if (url.pathname === '/comps' && request.method === 'PUT') { // your own sold-price memory, synced across devices
      const b = await request.json(); await env.SCOUT_KV.put('comps', JSON.stringify((b.comps || []).slice(0, 5000))); return json({ ok: true });
    }
    if (url.pathname === '/comps') return json({ comps: (await env.SCOUT_KV.get('comps', 'json')) || [] });
    if (url.pathname === '/pickups' && request.method === 'PUT') {
      const b = await request.json().catch(() => ({})); await env.SCOUT_KV.put('pickups', JSON.stringify({ days: Array.isArray(b.days) ? b.days.slice(0, 7) : [0, 3], pickups: Array.isArray(b.pickups) ? b.pickups.slice(0, 40) : [] })); return json({ ok: true });
    }
    if (url.pathname === '/inbox' && request.method === 'POST') {
      const b = await request.json().catch(() => ({})); if (!b.url || !/^https?:\/\//i.test(b.url)) return json({ error: 'url required' }, 400);
      return json(await handleInbox(env, b.url));
    }
    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const b = await request.json(); if (!b.sub || !b.sub.endpoint) return json({ error: 'bad subscription' }, 400);
      const subs = ((await env.SCOUT_KV.get('subs', 'json')) || []).filter(s => s.sub.endpoint !== b.sub.endpoint);
      subs.push({ sub: b.sub, ua: b.ua || '', at: Date.now() }); await env.SCOUT_KV.put('subs', JSON.stringify(subs.slice(-10)));
      return json({ ok: true, devices: subs.length, vapid: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE) });
    }
    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const b = await request.json(); const subs = ((await env.SCOUT_KV.get('subs', 'json')) || []).filter(s => s.sub.endpoint !== b.endpoint);
      await env.SCOUT_KV.put('subs', JSON.stringify(subs)); return json({ ok: true, devices: subs.length });
    }
    if (url.pathname === '/push/test' && request.method === 'POST') {
      try { const sent = await broadcast(env, { title: 'Resell & Co', body: 'Push is working. You\'ll get deals here even with the app closed.', tag: 'rc-test', url: './' }); return json({ ok: true, sent }); }
      catch (e) { return json({ ok: false, error: e.message }, 500); }
    }
    return json({ error: 'not found' }, 404);
  }
};
