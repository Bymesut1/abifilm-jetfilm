// ============================================================
//  filmabisi4 — Nuvio scraper (dizipod.com)
//  Akış: sayfa -> data-post-id -> admin-ajax get_episode_player
//        -> iframe (player.dizipod.com/embed/...) -> m3u8
// ============================================================

var SITE = {
  DOMAIN: 'https://dizipod.com',
  AJAX: '/wp/wp-admin/admin-ajax.php',
  NAME: 'filmabisi4',
  // true iken akış bulunamazsa nedenini "DEBUG" satırları olarak gösterir. Çalışınca false yap.
  DEBUG: true
};

var TMDB_KEY = '000316508321ce461cf81e7c6815eec7';
var PROVIDER_ID = 'filmabisi4';
var UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

var dbg = [];
function log(m) { try { console.log('[filmabisi4] ' + m); } catch (e) {} }

// ---------------- Yardımcılar ----------------

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); },
                 function (e) { clearTimeout(t); reject(e); });
  });
}

function pageHeaders(referer) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9',
    'Referer': referer || (SITE.DOMAIN + '/')
  };
}

function getText(url, headers, label) {
  return withTimeout(fetch(url, { headers: headers || pageHeaders() }), 10000).then(function (res) {
    return withTimeout(res.text(), 10000).then(
      function (t) { return { status: res.status, ok: res.ok, text: t || '' }; },
      function () { return { status: res.status, ok: false, text: '' }; }
    );
  }).catch(function (e) {
    return { status: 0, ok: false, text: '', err: (e && e.message) || 'hata' };
  }).then(function (r) {
    if (label) dbg.push(label + ' ' + (r.status || r.err || '?') + '/' + r.text.length);
    return r.ok ? r.text : '';
  });
}

function decodeHtml(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

var TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
function asciiLower(s) {
  return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase()
    .replace(/[çğıöşüâîû]/g, function (c) { return TR_MAP[c]; });
}
function norm(s) { return asciiLower(s).replace(/[^a-z0-9]/g, ''); }
function slugify(s) {
  return asciiLower(s).replace(/['’`]/g, '').replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function originOf(u) { return (String(u).match(/^https?:\/\/[^\/]+/) || [''])[0]; }

function absUrl(u) {
  u = decodeHtml(String(u || '').trim());
  if (/^\/\//.test(u)) return 'https:' + u;
  if (/^\//.test(u)) return SITE.DOMAIN + u;
  return u;
}

function hexUnescape(s) {
  return String(s || '')
    .replace(/\\x([0-9a-fA-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\u([0-9a-fA-F]{4})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\\//g, '/');
}

// eval(function(p,a,c,k,e,d)...) açıcı
function unpackPacked(src) {
  var m = String(src || '').match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
  if (!m) return '';
  var p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  var a = parseInt(m[2], 10), c = parseInt(m[3], 10), k = m[4].split('|');
  function enc(n) {
    return (n < a ? '' : enc(Math.floor(n / a))) +
           ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  }
  var d = {};
  while (c--) d[enc(c)] = k[c] || enc(c);
  return p.replace(/\b\w+\b/g, function (w) { return d[w] !== undefined ? d[w] : w; });
}
function unpackAll(text) {
  var list = [String(text || '')], cur = list[0];
  for (var i = 0; i < 3; i++) {
    var u = unpackPacked(cur);
    if (!u) break;
    list.push(u);
    cur = u;
  }
  return list;
}

var BAD_EXT = /\.(vtt|srt|jpg|jpeg|png|webp|gif|css|js|ico|svg)(\?|$)/i;

// Metinden m3u8 / mp4 akış adresi bulur (embed sayfasının kendisi .mp4 ile bittiği için ona bakılmaz)
function findStreamUrl(text) {
  text = hexUnescape(text).replace(/&amp;/g, '&');
  var urls = text.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  var i, u;
  for (i = 0; i < urls.length; i++) {
    u = urls[i];
    if (/\.m3u8/i.test(u) && !BAD_EXT.test(u)) {
      var best = u;
      for (var j = 0; j < urls.length; j++) {
        if (/\.m3u8/i.test(urls[j]) && /master/i.test(urls[j])) { best = urls[j]; break; }
      }
      return { url: best, type: 'hls' };
    }
  }
  var sm = text.match(/<(?:source|video)[^>]*\ssrc=["'](https?:\/\/[^"']+)["']/i);
  if (sm && !BAD_EXT.test(sm[1])) return { url: sm[1], type: /\.mp4(\?|$)/i.test(sm[1]) ? 'mp4' : 'hls' };
  var f = text.match(/file\s*["']?\s*:\s*["']([^"']+\.mp4[^"']*)["']/);
  if (f) return { url: f[1], type: 'mp4' };
  return null;
}

function qualityOf(u) {
  var m = String(u).match(/[-_\/](\d{3,4})p?[-_.\/]/);
  return m ? m[1] + 'p' : 'Auto';
}

// ---------------- Sayfa bulma ----------------

function pageNames(html) {
  var names = [];
  var h1 = (html.match(/<h1[^>]*>\s*([^<]+)/) || [])[1];
  var h4 = (html.match(/<h4[^>]*serie_original_episode_name[^>]*>\s*([^<&]+)/) || [])[1];
  [h1, h4].forEach(function (n) { if (n) names.push(decodeHtml(n).trim()); });
  return names;
}
function pageYear(html) {
  return parseInt((html.match(/\/yil\/(\d{4})\//) || [])[1], 10) || 0;
}
function hasPlayer(html) { return /id="episode-player-container"/.test(html); }

function isRightMovie(html, title, origTitle, year) {
  if (!hasPlayer(html)) return false;
  var y = parseInt(year, 10), py = pageYear(html);
  if (py && y && Math.abs(py - y) > 1) return false;
  var want = [norm(title), norm(origTitle)].filter(function (n) { return n && n.length >= 2; });
  var names = pageNames(html);
  if (!names.length) return true;
  for (var i = 0; i < names.length; i++) {
    var a = norm(names[i]);
    for (var j = 0; j < want.length; j++) {
      if (a === want[j] || (want[j].length >= 6 && (a.indexOf(want[j]) > -1 || want[j].indexOf(a) > -1))) return true;
    }
  }
  return false;
}

function pickFirst(paths, validate) {
  return Promise.all(paths.map(function (p, i) {
    return getText(SITE.DOMAIN + p, null, 'P' + (i + 1));
  })).then(function (pages) {
    for (var i = 0; i < pages.length; i++) {
      if (pages[i] && validate(pages[i])) return { url: SITE.DOMAIN + paths[i], html: pages[i] };
    }
    return null;
  });
}

function uniq(arr) {
  var out = [];
  arr.forEach(function (x) { if (x && out.indexOf(x) === -1) out.push(x); });
  return out;
}

// Sayfadaki dizipod.com iç linklerinin yolları
function pathsFromHtml(html) {
  var re = /href=["']([^"'#]+)["']/gi, m, out = [];
  while ((m = re.exec(String(html || ''))) !== null) {
    var u = absUrl(m[1]);
    if (u.indexOf(SITE.DOMAIN) !== 0) continue;
    var p = u.substr(SITE.DOMAIN.length).split('?')[0];
    if (p.length < 4 || /^\/wp-|\.(css|js|png|jpe?g|webp|svg|ico|xml)$/i.test(p)) continue;
    if (out.indexOf(p) === -1) out.push(p);
  }
  return out;
}

// Arama: önce WordPress REST araması, sonra normal /?s= sayfası
function searchPaths(query, tag) {
  var q = encodeURIComponent(query);
  var h = pageHeaders();
  h['Accept'] = 'application/json';
  return Promise.all([
    getText(SITE.DOMAIN + '/wp-json/wp/v2/search?per_page=10&search=' + q, h, 'WJ' + tag),
    getText(SITE.DOMAIN + '/?s=' + q, null, 'S' + tag)
  ]).then(function (r) {
    var out = [];
    try {
      var arr = JSON.parse(r[0] || '[]');
      (arr || []).forEach(function (x) {
        var u = absUrl(x && x.url);
        if (u.indexOf(SITE.DOMAIN) === 0) out.push(u.substr(SITE.DOMAIN.length));
      });
    } catch (e) {}
    dbg.push('wpjson ' + out.length);
    var fromHtml = pathsFromHtml(r[1]);
    fromHtml.forEach(function (p) { if (out.indexOf(p) === -1) out.push(p); });
    return out;
  });
}

function findMoviePage(title, origTitle, year) {
  var slugs = uniq([slugify(origTitle), slugify(title)]);
  var paths = [];
  slugs.forEach(function (s) { paths.push('/film/' + s + '/'); });
  slugs.forEach(function (s) { paths.push('/film/' + s + '-' + year + '/'); });

  return pickFirst(paths, function (h) { return isRightMovie(h, title, origTitle, year); }).then(function (found) {
    if (found) return found;
    var queries = uniq([origTitle, title]).filter(function (q) { return norm(q).length >= 2; });
    return Promise.all(queries.map(function (q, i) { return searchPaths(q, i + 1); })).then(function (lists) {
      var all = [];
      lists.forEach(function (l) { l.forEach(function (p) { if (all.indexOf(p) === -1) all.push(p); }); });
      var cand = all.filter(function (p) { return /^\/film\//.test(p) && paths.indexOf(p) === -1; }).slice(0, 6);
      dbg.push('aday ' + cand.length + ' / link ' + all.length);
      if (!cand.length) {
        dbg.push('ornek ' + all.slice(0, 4).join(' '));
        return null;
      }
      return pickFirst(cand, function (h) { return isRightMovie(h, title, origTitle, year); });
    });
  });
}

function findEpisodePage(names, season, episode) {
  names = names.filter(function (n) { return slugify(n); });
  var slugs = uniq(names.map(slugify));
  var paths = slugs.map(function (s) { return '/' + s + '-' + season + '-sezon-' + episode + '-bolum/'; });
  dbg.push('slug ' + slugs.join(','));

  return pickFirst(paths, hasPlayer).then(function (found) {
    if (found || !slugs.length) return found;
    var epRe = new RegExp('(?:-|/)' + season + '-sezon-' + episode + '-bolum/?$|sezon-' + season + '/bolum-' + episode + '/?$');
    var queries = uniq(names).slice(0, 3);
    return Promise.all(queries.map(function (q, i) { return searchPaths(q, i + 1); })).then(function (lists) {
      var all = [];
      lists.forEach(function (l) { l.forEach(function (p) { if (all.indexOf(p) === -1) all.push(p); }); });
      var direct = all.filter(function (p) { return epRe.test(p) && paths.indexOf(p) === -1; });
      var series = all.filter(function (p) {
        return !epRe.test(p) && slugs.some(function (s) { return p.indexOf(s) > -1; });
      }).slice(0, 3);
      dbg.push('direkt ' + direct.length + ' dizi ' + series.length + ' / link ' + all.length);
      if (!direct.length && !series.length) dbg.push('ornek ' + all.slice(0, 4).join(' '));
      if (direct.length) return pickFirst(direct.slice(0, 4), hasPlayer);
      if (!series.length) return null;
      return Promise.all(series.map(function (p, i) {
        return getText(SITE.DOMAIN + p, null, 'D' + (i + 1));
      })).then(function (pages) {
        var eps = [];
        pages.forEach(function (h) {
          pathsFromHtml(h).forEach(function (p) { if (epRe.test(p) && eps.indexOf(p) === -1) eps.push(p); });
        });
        dbg.push('bolum linki ' + eps.length);
        if (!eps.length) {
          dbg.push('dizi ornek ' + series[0]);
          return null;
        }
        return pickFirst(eps.slice(0, 4), hasPlayer);
      });
    });
  });
}

// ---------------- Oynatıcı çözme ----------------

function postIdOf(html) {
  var m = html.match(/id="episode-player-container"[^>]*data-post-id="(\d+)"/) ||
          html.match(/data-post-id="(\d+)"/) ||
          html.match(/postid-(\d+)/);
  return m ? m[1] : '';
}

function iframesOf(html) {
  var out = [], re = /<iframe[^>]+?(?:src|data-src)=["']([^"']+)["']/gi, m;
  while ((m = re.exec(String(html || ''))) !== null) {
    var u = absUrl(m[1]);
    if (/^https?:\/\//.test(u) && !/youtube\.com|youtu\.be/.test(u) && out.indexOf(u) === -1) out.push(u);
  }
  return out;
}

function fetchPlayerHtml(postId, pageUrl) {
  var url = SITE.DOMAIN + SITE.AJAX + '?action=get_episode_player&post_id=' + postId;
  var h = pageHeaders(pageUrl);
  h['Accept'] = 'application/json, text/javascript, */*; q=0.01';
  h['X-Requested-With'] = 'XMLHttpRequest';
  return getText(url, h, 'AJAX').then(function (txt) {
    if (!txt) return '';
    try {
      var j = JSON.parse(txt);
      if (j && j.success && typeof j.data === 'string') return j.data;
      dbg.push('ajax success=' + (j && j.success));
      return typeof (j && j.data) === 'string' ? j.data : '';
    } catch (e) {
      return txt; // JSON değilse düz HTML olabilir
    }
  });
}

function resolveEmbed(embedUrl, referer, depth) {
  if (/\.m3u8(\?|$)/i.test(embedUrl)) {
    return Promise.resolve({ url: embedUrl, type: 'hls', headers: { 'User-Agent': UA, 'Referer': referer } });
  }
  return getText(embedUrl, pageHeaders(referer), 'E' + depth).then(function (html) {
    if (!html) return null;
    var texts = unpackAll(html), found = null;
    for (var i = 0; i < texts.length && !found; i++) found = findStreamUrl(texts[i]);
    if (found) {
      found.headers = { 'User-Agent': UA, 'Referer': originOf(embedUrl) + '/' };
      return found;
    }
    if (depth < 2) {
      var inner = iframesOf(html);
      if (inner.length) return resolveEmbed(inner[0], embedUrl, depth + 1);
    }
    dbg.push('embed akış yok: ' + html.substr(0, 80).replace(/\s+/g, ' '));
    return null;
  });
}

function streamsFromPage(found, label) {
  var postId = postIdOf(found.html);
  if (!postId) return Promise.resolve(debugStream('post-id yok'));
  dbg.push('post ' + postId);

  return fetchPlayerHtml(postId, found.url).then(function (playerHtml) {
    if (!playerHtml) return debugStream('ajax boş');
    var direct = findStreamUrl(playerHtml);
    var frames = iframesOf(playerHtml);
    dbg.push('iframe ' + frames.length);

    var jobs = frames.map(function (f) {
      return resolveEmbed(f, found.url, 0).catch(function () { return null; });
    });
    if (direct && !frames.length) {
      direct.headers = { 'User-Agent': UA, 'Referer': found.url };
      jobs.push(Promise.resolve(direct));
    }
    return Promise.all(jobs).then(function (res) {
      var streams = [], seen = {};
      res.forEach(function (r, i) {
        if (!r || seen[r.url]) return;
        seen[r.url] = true;
        var q = qualityOf(r.url);
        streams.push({
          name: SITE.NAME,
          title: label + ' | Kaynak ' + (i + 1) + (q !== 'Auto' ? ' | ' + q : ''),
          url: r.url,
          quality: q,
          type: r.type,
          headers: r.headers,
          provider: PROVIDER_ID
        });
      });
      return streams.length ? streams : debugStream('cozulemedi');
    });
  });
}

function debugStream(msg) {
  if (!SITE.DEBUG) return [];
  return [msg].concat(dbg.slice(0, 40)).map(function (r) {
    return { name: 'DEBUG ' + r, title: 'DEBUG ' + r, url: 'https://debug.invalid/', quality: 'Auto', provider: PROVIDER_ID };
  });
}

// ============================================================
//  NUVIO GİRİŞ NOKTASI
// ============================================================

function getJson(url) {
  return withTimeout(fetch(url), 10000).then(function (res) { return res.json(); });
}

function getStreams(tmdbId, mediaType, season, episode) {
  dbg = [];
  var isTv = mediaType === 'tv';
  if (!isTv && mediaType !== 'movie') return Promise.resolve([]);

  var base = 'https://api.themoviedb.org/3/' + (isTv ? 'tv/' : 'movie/') + tmdbId + '?api_key=' + TMDB_KEY;

  return Promise.all([
    getJson(base + '&language=tr-TR'),
    getJson(base + '&language=en-US').catch(function () { return {}; })
  ]).then(function (both) {
      var info = both[0], en = both[1] || {};
      if (isTv) {
        var name = info.name, orig = info.original_name;
        if (!name) return debugStream('TMDB bilgisi eksik');
        var s = parseInt(season, 10) || 1, e = parseInt(episode, 10) || 1;
        // Kore/Japon dizilerinde orijinal ad ASCII değil; İngilizce ad ve TR ad yedek olarak denenir
        var names = uniq([orig, en.name, name]);
        return findEpisodePage(names, s, e).then(function (found) {
          if (!found) return debugStream('bolum sayfasi yok: ' + (en.name || name) + ' ' + s + 'x' + e);
          log('sayfa: ' + found.url);
          return streamsFromPage(found, (en.name || name) + ' S' + s + 'E' + e);
        });
      }
      var title = info.title, origTitle = info.original_title;
      var year = (info.release_date || '').slice(0, 4);
      if (!title || !year) return debugStream('TMDB bilgisi eksik');
      var origs = uniq([origTitle, en.title]);
      return findMoviePage(title, origs[0], year).then(function (found) {
        if (!found && origs[1] && slugify(origs[1]) !== slugify(origs[0])) return findMoviePage(title, origs[1], year);
        return found;
      }).then(function (found) {
        if (!found) return debugStream('sayfa yok: ' + title + ' ' + year);
        log('sayfa: ' + found.url);
        return streamsFromPage(found, SITE.NAME);
      });
    })
    .catch(function (e) { return debugStream('hata ' + (e && e.message)); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams, _t: { findStreamUrl: findStreamUrl, iframesOf: iframesOf, postIdOf: postIdOf, slugify: slugify, qualityOf: qualityOf } };
} else {
  global.getStreams = getStreams;
}
