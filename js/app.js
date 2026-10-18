/*
 * Soles — Finanzas Perú (PWA)
 * Principios de seguridad:
 *  - Sin servidor propio, sin login, sin base de datos: no hay nada que robar ni atacar.
 *  - Nunca se usa innerHTML ni eval: el texto se inserta con textContent (anti-XSS).
 *  - Los datos externos (data/data.json) se validan estrictamente antes de usarse.
 *  - Los datos del usuario viven solo en su celular (localStorage) y se validan al leerlos.
 *  - La política CSP de index.html solo permite ejecutar código de este mismo sitio.
 */
'use strict';
(function () {
  // Evita que la app sea embebida dentro de otra página (clickjacking).
  if (window.top !== window.self) {
    document.documentElement.replaceChildren();
    return;
  }

  // ===================== CONSTANTES =====================
  const TARGET_LOW = 1, TARGET_HIGH = 3;
  const TYPES = { caja: 'Caja', banco: 'Banco', fin: 'Financ.' };
  const LABEL_RE = /^[0-9A-Za-zÁÉÍÓÚÜáéíóúüÑñ.\- ()]{1,40}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_DEPS = 50;

  // Datos de respaldo (se usan si data/data.json no está disponible o no es válido).
  const DEFAULT_RAW = {
    version: 1,
    updated: '2026-10-04',
    inflation: { source: 'BCRP/INEI', points: [
      ['Ene.2024',3.02],['Feb.2024',3.29],['Mar.2024',3.05],['Abr.2024',2.42],['May.2024',2.00],['Jun.2024',2.29],
      ['Jul.2024',2.13],['Ago.2024',2.03],['Sep.2024',1.78],['Oct.2024',2.01],['Nov.2024',2.27],['Dic.2024',1.97],
      ['Ene.2025',1.85],['Feb.2025',1.48],['Mar.2025',1.28],['Abr.2025',1.65],['May.2025',1.69],['Jun.2025',1.69],
      ['Jul.2025',1.69],['Ago.2025',1.11],['Sep.2025',1.36],['Oct.2025',1.35],['Nov.2025',1.37],['Dic.2025',1.51],
      ['Ene.2026',1.70],['Feb.2026',2.21],['Mar.2026',3.80],['Abr.2026',4.01],['May.2026',3.91],['Jun.2026',4.01],
      ['Jul.2026',4.07],['Ago.2026',4.44]
    ]},
    fx: { source: 'BCRP', points: [
      ['24.Jul.26',3.411],['31.Jul.26',3.400],['03.Ago.26',3.402],['01.Oct.26',3.453],['02.Oct.26',3.436]
    ]},
    rates: { asOf: '2026-08', items: [
      ['Caja Arequipa','caja',8.50],['Caja Huancayo','caja',8.25],['Caja Piura','caja',8.00],
      ['Caja Cusco','caja',7.13],['Caja Incasur','caja',6.04],['Caja Los Andes','caja',5.96],
      ['Caja Maynas','caja',5.94],['Caja Del Centro','caja',5.88],['Financiera Efectiva','fin',5.87],
      ['Interbank','banco',3.76],['Banco Falabella','banco',3.65],['Santander','banco',3.44],
      ['BBVA','banco',3.27],['Scotiabank','banco',3.07],['BCP','banco',2.87]
    ]}
  };

  // ===================== VALIDACIÓN =====================
  function isNum(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }

  function validPoints(arr, lo, hi) {
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 400) return null;
    const out = [];
    for (const p of arr) {
      if (!Array.isArray(p) || p.length !== 2) return null;
      const name = p[0], v = p[1];
      if (typeof name !== 'string' || !LABEL_RE.test(name) || !isNum(v, lo, hi)) return null;
      out.push({ name: name, v: v });
    }
    return out;
  }

  function validateData(d) {
    if (!d || typeof d !== 'object' || d.version !== 1) return null;
    if (typeof d.updated !== 'string' || !DATE_RE.test(d.updated)) return null;
    const inflation = validPoints(d.inflation && d.inflation.points, -10, 50);
    const fx = validPoints(d.fx && d.fx.points, 1, 10);
    const items = d.rates && d.rates.items;
    if (!inflation || !fx || !Array.isArray(items) || items.length < 1 || items.length > 60) return null;
    const rates = [];
    for (const r of items) {
      if (!Array.isArray(r) || r.length !== 3) return null;
      const name = r[0], type = r[1], rate = r[2];
      if (typeof name !== 'string' || !LABEL_RE.test(name)) return null;
      if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPES, type)) return null;
      if (!isNum(rate, 0, 25)) return null;
      rates.push({ name: name, type: type, rate: rate });
    }
    const asOf = (typeof d.rates.asOf === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(d.rates.asOf)) ? d.rates.asOf : '';
    const source = d.rates.source === 'SBS' ? 'SBS' : 'referencial';
    let bankAvg = null;
    if (d.bankAvg && typeof d.bankAvg === 'object' && typeof d.bankAvg.period === 'string' &&
        LABEL_RE.test(d.bankAvg.period) && isNum(d.bankAvg.value, 0, 25)) {
      bankAvg = { period: d.bankAvg.period, value: d.bankAvg.value };
    }
    return { updated: d.updated, inflation: inflation, fx: fx, rates: rates, ratesAsOf: asOf, ratesSource: source, bankAvg: bankAvg };
  }

  const DEFAULT_DATA = validateData(DEFAULT_RAW);
  const state = { data: DEFAULT_DATA, remote: false };

  async function loadRemote() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(function () { ctrl.abort(); }, 8000);
      const res = await fetch('data/data.json', { cache: 'no-cache', credentials: 'omit', redirect: 'error', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const txt = await res.text();
      if (txt.length > 200000) return null;
      return validateData(JSON.parse(txt));
    } catch (e) { return null; }
  }

  // ===================== ALMACENAMIENTO LOCAL =====================
  const PREFIX = 'soles.v1.';
  const store = {
    get: function (k, d) { try { const v = localStorage.getItem(PREFIX + k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(PREFIX + k, String(v)); } catch (e) { /* lleno o bloqueado */ } }
  };

  // ===================== UTILIDADES DOM (seguras) =====================
  const $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, children) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (children !== undefined) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c === null || c === undefined) return;
        e.append(c instanceof Node ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }
  const b = function (t) { return el('b', null, t); };
  function setText(id, t) { $(id).textContent = t; }

  function num(id, lo, hi, def) {
    const v = parseFloat($(id).value);
    if (!Number.isFinite(v)) return def;
    return Math.min(hi, Math.max(lo, v));
  }
  function pick(id, allowed, def) {
    const v = $(id).value;
    return allowed.indexOf(v) >= 0 ? v : def;
  }

  function fmtPct(v, dec) { dec = dec === undefined ? 2 : dec; return v.toFixed(dec).replace('.', ',') + '%'; }
  function fmtS(v, dec) {
    dec = dec || 0;
    const sign = v < 0 ? '−' : '';
    return sign + 'S/ ' + Math.abs(v).toLocaleString('es-PE', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  // ===================== GRÁFICOS SVG (sin librerías externas) =====================
  const SVGNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
    return e;
  }

  function lineChart(host, opts) {
    host.replaceChildren();
    const W = Math.max(200, Math.round(host.clientWidth || 340));
    const H = opts.height || 180;
    const spark = !!opts.spark;
    const pad = spark ? { l: 2, r: 2, t: 4, b: 4 } : { l: 44, r: 10, t: 10, b: 22 };
    let vals = [];
    opts.series.forEach(function (s) { vals = vals.concat(s.values); });
    if (opts.band) vals = vals.concat(opts.band);
    let min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (opts.zeroBase) min = Math.min(0, min);
    if (max === min) { max += 1; min -= 1; }
    const span = max - min;
    if (!opts.zeroBase) min -= span * 0.08;
    max += span * 0.08;
    const n = opts.labels.length;
    const X = function (i) { return pad.l + (n <= 1 ? 0 : i * (W - pad.l - pad.r) / (n - 1)); };
    const Y = function (v) { return pad.t + (max - v) * (H - pad.t - pad.b) / (max - min); };

    const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': opts.aria || 'Gráfico' });

    if (!spark) {
      for (let k = 0; k <= 3; k++) {
        const v = min + (max - min) * k / 3;
        root.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: Y(v), y2: Y(v), class: 'grid' }));
        const t = svg('text', { x: pad.l - 5, y: Y(v) + 3, 'text-anchor': 'end' });
        t.textContent = opts.yFmt(v);
        root.append(t);
      }
      const idxs = n > 2 ? [0, Math.floor((n - 1) / 2), n - 1] : (n === 2 ? [0, -1, 1] : [0, -1, -1]);
      idxs.forEach(function (i, pos) {
        if (i < 0) return;
        const t = svg('text', { x: X(i), y: H - 6, 'text-anchor': pos === 0 ? 'start' : pos === 2 ? 'end' : 'middle' });
        t.textContent = opts.labels[i];
        root.append(t);
      });
    }

    if (opts.band) {
      root.append(svg('rect', { x: pad.l, y: Y(opts.band[1]), width: W - pad.l - pad.r, height: Math.max(0, Y(opts.band[0]) - Y(opts.band[1])), class: 'band' }));
    }

    opts.series.forEach(function (s) {
      const d = s.values.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1); }).join('');
      if (s.area) {
        root.append(svg('path', { d: d + 'L' + X(n - 1).toFixed(1) + ',' + Y(min).toFixed(1) + 'L' + X(0).toFixed(1) + ',' + Y(min).toFixed(1) + 'Z', fill: s.area, stroke: 'none' }));
      }
      const p = svg('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
      if (s.dash) p.setAttribute('stroke-dasharray', s.dash);
      root.append(p);
    });

    if (opts.readout && n > 0) {
      const guide = svg('line', { x1: 0, x2: 0, y1: pad.t, y2: H - pad.b, class: 'guide', visibility: 'hidden' });
      const dot = svg('circle', { r: 4, fill: opts.series[0].color, visibility: 'hidden' });
      const hit = svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
      root.append(guide, dot, hit);
      const show = function (ev) {
        const rect = root.getBoundingClientRect();
        if (!rect.width) return;
        const px = (ev.clientX - rect.left) * (W / rect.width);
        let i = n <= 1 ? 0 : Math.round((px - pad.l) / ((W - pad.l - pad.r) / (n - 1)));
        i = Math.max(0, Math.min(n - 1, i));
        const v = opts.series[0].values[i];
        guide.setAttribute('x1', X(i)); guide.setAttribute('x2', X(i)); guide.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(v)); dot.setAttribute('visibility', 'visible');
        opts.readout.textContent = opts.labels[i] + ': ' + opts.readFmt(i);
      };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerdown', show);
    }
    host.append(root);
  }

  // ===================== NAVEGACIÓN =====================
  const VIEWS = ['inicio', 'tasas', 'calc', 'ahorros'];
  function go(name) {
    if (VIEWS.indexOf(name) < 0) return;
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'v-' + name); });
    document.querySelectorAll('.tabbar button').forEach(function (bt) { bt.classList.toggle('active', bt.dataset.view === name); });
    window.scrollTo(0, 0);
    if (name === 'inicio') renderInicio();
    if (name === 'calc') renderComp();
    if (name === 'ahorros') renderDeps();
  }
  const SUBS = ['grati', 'cts', 'comp', 'meta'];
  function goSub(name) {
    if (SUBS.indexOf(name) < 0) return;
    document.querySelectorAll('.subtabs button').forEach(function (bt) { bt.classList.toggle('active', bt.dataset.sub === name); });
    document.querySelectorAll('.subview').forEach(function (v) { v.classList.toggle('active', v.id === 's-' + name); });
    if (name === 'comp') renderComp();
  }

  // ===================== INICIO =====================
  function currentInflation() { const p = state.data.inflation; return p[p.length - 1].v; }

  function renderInicio() {
    const d = state.data;
    const fx = d.fx, last = fx[fx.length - 1], prev = fx.length > 1 ? fx[fx.length - 2] : null;
    setText('fxVal', 'S/ ' + last.v.toFixed(3));
    setText('fxDate', last.name);
    const fxDelta = $('fxDelta');
    if (prev) {
      const delta = last.v - prev.v;
      fxDelta.textContent = (delta >= 0 ? '▲ +' : '▼ ') + Math.abs(delta).toFixed(3) + ' vs ' + prev.name;
      fxDelta.className = 'sub ' + (delta > 0 ? 'neg' : 'pos');
    } else { fxDelta.textContent = ''; }
    if ($('fxSpark').offsetParent) {
      lineChart($('fxSpark'), { spark: true, height: 44, labels: fx.map(function (p) { return p.name; }),
        series: [{ values: fx.map(function (p) { return p.v; }), color: '#b91c1c', width: 2 }], aria: 'Evolución del dólar' });
    }

    const inf = d.inflation, il = inf[inf.length - 1];
    setText('infVal', fmtPct(il.v));
    setText('infMonth', 'a ' + il.name);
    const badge = $('infBadge');
    const inRange = il.v >= TARGET_LOW && il.v <= TARGET_HIGH;
    badge.textContent = inRange ? 'En rango meta (1–3%)' : 'Fuera del rango meta';
    badge.className = 'badge ' + (inRange ? 'in' : 'out');
    if ($('infChart').offsetParent) {
      lineChart($('infChart'), { height: 190, labels: inf.map(function (p) { return p.name; }),
        series: [{ values: inf.map(function (p) { return p.v; }), color: '#2563eb' }],
        band: [TARGET_LOW, TARGET_HIGH], yFmt: function (v) { return v.toFixed(1) + '%'; },
        readout: $('infReadout'), readFmt: function (i) { return fmtPct(inf[i].v); }, aria: 'Inflación anual' });
    }

    const best = d.rates.slice().sort(function (a, c) { return c.rate - a.rate; })[0];
    setText('bestRate', fmtPct(best.rate));
    setText('bestName', best.name);
    setText('bestBadge', d.ratesSource === 'SBS' ? 'Promedio SBS · plazo fijo' : 'Plazo fijo en soles');
  }

  function renderStatus() {
    const s = $('status');
    const d = state.data;
    const dias = Math.floor((new Date() - new Date(d.updated + 'T12:00:00')) / 86400000);
    const hace = dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : 'hace ' + dias + ' días';
    s.replaceChildren('Datos oficiales BCRP/INEI · Inflación a ' + d.inflation[d.inflation.length - 1].name +
      ' · Dólar al ' + d.fx[d.fx.length - 1].name + ' · actualizado ' + hace);
    if (dias > 7) s.append(el('span', 'warn', '⚠️ Datos con más de una semana sin actualizarse.'));
  }

  // ===================== TASAS =====================
  function renderRates() {
    const monto = num('monto', 0, 1e9, 0);
    const meses = parseInt(pick('plazo', ['6', '12', '24', '36'], '12'), 10);
    const mine = num('miTasa', 0, 25, 0);
    store.set('monto', monto); store.set('plazo', meses); store.set('miTasa', mine);
    const gain = function (rate) { return monto * (Math.pow(1 + rate / 100, meses / 12) - 1); };
    const infl = currentInflation();

    const rows = state.data.rates.map(function (r) { return { name: r.name, type: r.type, rate: r.rate, mine: false }; });
    rows.push({ name: 'Mi cuenta actual', type: 'tuyo', rate: mine, mine: true });
    rows.sort(function (a, c) { return c.rate - a.rate; });
    const best = rows.filter(function (r) { return !r.mine; })[0];

    $('bestBox').replaceChildren('🏆 Con ', b(fmtS(monto)), ' a ', b(meses + ' meses'), ': ', b(best.name),
      ' te da ', b(fmtS(gain(best.rate))), ' — ', b(fmtS(gain(best.rate) - gain(mine))),
      ' más que tu cuenta actual (' + fmtPct(mine) + ').');

    const ba = $('bankAvg');
    if (state.data.bankAvg) {
      const v = state.data.bankAvg.value;
      ba.replaceChildren('🏦 Promedio de todos los bancos: ', b(fmtPct(v)), ' (' + state.data.bankAvg.period + ')',
        el('span', 'note', 'Fuente BCRP, depósitos a plazo de 360 días a más. Se actualiza solo cada mes. Con tu monto ganarías ' + fmtS(gain(v)) + '.'));
      ba.classList.remove('hidden');
    } else { ba.classList.add('hidden'); }

    const body = $('rateBody');
    body.replaceChildren();
    rows.forEach(function (r) {
      const real = r.rate - infl;
      const tr = el('tr', r.mine ? 'mine' : (r === best ? 'top' : null));
      const tag = el('span', 'tag ' + r.type, r.mine ? 'Tú' : TYPES[r.type]);
      tr.append(
        el('td', null, [r.name, tag]),
        el('td', 'num', fmtPct(r.rate)),
        el('td', 'num', fmtS(gain(r.rate))),
        el('td', 'num ' + (real >= 0 ? 'pos' : 'neg'), (real >= 0 ? '+' : '') + fmtPct(real, 1))
      );
      body.append(tr);
    });
    const sbs = state.data.ratesSource === 'SBS';
    $('ratesNote').textContent = '🛡️ Entidades supervisadas por la SBS y cubiertas por el Fondo de Seguro de Depósitos (hasta ~S/117,200 por persona y entidad). ' +
      (sbs ? 'TEA promedio oficial de la SBS (operaciones reales recientes) para depósitos a plazo en soles a más de 360 días'
           : 'TEA referenciales en soles a más de 360 días') +
      (state.data.ratesAsOf ? ' (' + state.data.ratesAsOf + ')' : '') +
      '. Las campañas de cada entidad pueden pagar más: confírmalo antes de contratar. "Real" = TEA − inflación vigente (' + fmtPct(infl, 1) + ').';
  }

  // ===================== CALCULADORAS =====================
  function result(id, lines, total, note) {
    const box = $(id);
    box.replaceChildren();
    lines.forEach(function (l) { box.append(el('div', null, [l[0] + ': ', b(l[1])])); });
    if (total) box.append(el('span', 'total', total));
    if (note) box.append(el('span', 'note', note));
  }

  function renderGrati() {
    const s = num('gSueldo', 0, 1e6, 0);
    const m = parseInt(pick('gMeses', ['1','2','3','4','5','6'], '6'), 10);
    const reg = pick('gReg', ['general', 'pyme'], 'general');
    let g = s * m / 6;
    if (reg === 'pyme') g /= 2;
    const bono = g * 0.09;
    result('gRes', [['Gratificación', fmtS(g, 2)], ['Bono 9% EsSalud', fmtS(bono, 2)]], 'Total: ' + fmtS(g + bono, 2));
  }

  function renderCts() {
    const s = num('cSueldo', 0, 1e6, 0);
    const m = parseInt(pick('cMeses', ['1','2','3','4','5','6'], '6'), 10);
    const comp = s + s / 6;
    result('cRes', [['Remuneración computable', fmtS(comp, 2)]], 'Depósito CTS: ' + fmtS(comp * m / 12, 2));
  }

  function renderComp() {
    const ini = num('pIni', 0, 1e9, 0);
    const ap = num('pAporte', 0, 1e7, 0);
    const tea = num('pTasa', 0, 30, 0) / 100;
    const anios = Math.round(num('pAnios', 1, 40, 10));
    const rm = Math.pow(1 + tea, 1 / 12) - 1;
    const labels = ['Hoy'], tot = [ini], apo = [ini];
    let total = ini, aportado = ini;
    for (let a = 1; a <= anios; a++) {
      for (let k = 0; k < 12; k++) { total = total * (1 + rm) + ap; aportado += ap; }
      labels.push('Año ' + a); tot.push(total); apo.push(aportado);
    }
    result('pRes', [['Aportado por ti', fmtS(aportado)], ['Generado por interés', fmtS(total - aportado)]],
      'Total en ' + anios + ' años: ' + fmtS(total));
    const host = $('pChart');
    if (!host.offsetParent) return; // oculto: se dibuja al mostrarse
    lineChart(host, { height: 190, labels: labels, zeroBase: true,
      series: [{ values: tot, color: '#1d4ed8', area: 'rgba(29,78,216,0.08)' }, { values: apo, color: '#9ca3af', width: 1.5, dash: '5 4' }],
      yFmt: function (v) { return v >= 1e6 ? 'S/' + (v / 1e6).toFixed(1) + 'M' : v >= 1000 ? 'S/' + Math.round(v / 1000) + 'k' : 'S/' + Math.round(v); },
      readout: $('pReadout'), readFmt: function (i) { return fmtS(tot[i]) + ' (aportado ' + fmtS(apo[i]) + ')'; },
      aria: 'Proyección de inversión' });
  }

  function renderMeta() {
    const meta = num('mMeta', 0, 1e9, 0);
    const ini = num('mIni', 0, 1e9, 0);
    const anios = Math.round(num('mAnios', 1, 30, 1));
    const tea = num('mTasa', 0, 30, 0) / 100;
    const rm = Math.pow(1 + tea, 1 / 12) - 1;
    const n = anios * 12;
    const fvIni = ini * Math.pow(1 + rm, n);
    let cuota;
    if (meta <= fvIni) cuota = 0;
    else if (rm === 0) cuota = (meta - fvIni) / n;
    else cuota = (meta - fvIni) * rm / (Math.pow(1 + rm, n) - 1);
    const box = $('mRes');
    box.replaceChildren();
    if (cuota === 0) {
      box.append('🎉 Con lo que ya tienes y esa tasa, ', b('llegas a tu meta sin aportar más'), '.');
    } else {
      box.append('Para juntar ', b(fmtS(meta)), ' en ', b(anios + ' años'), ':');
      box.append(el('span', 'total', 'Ahorra ' + fmtS(cuota) + ' al mes'));
      box.append(el('span', 'note', 'Aportarías ' + fmtS(cuota * n) + ' y el interés pone ' + fmtS(Math.max(0, meta - ini - cuota * n)) + '.'));
    }
  }

  // ===================== MIS AHORROS =====================
  function cleanName(s) {
    // Quita caracteres de control y limita la longitud. Siempre se muestra con textContent.
    return String(s).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 40);
  }

  function getDeps() {
    let raw;
    try { raw = JSON.parse(store.get('deps', '[]')); } catch (e) { return []; }
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const d of raw.slice(0, MAX_DEPS)) {
      if (!d || typeof d !== 'object') continue;
      const name = typeof d.name === 'string' ? cleanName(d.name) : '';
      if (!name || !isNum(d.id, 0, 1e15) || !isNum(d.monto, 0.01, 1e9) || !isNum(d.tasa, 0, 30)) continue;
      const vence = (typeof d.vence === 'string' && DATE_RE.test(d.vence)) ? d.vence : null;
      out.push({ id: d.id, name: name, monto: d.monto, tasa: d.tasa, vence: vence });
    }
    return out;
  }
  function saveDeps(list) { store.set('deps', JSON.stringify(list.slice(0, MAX_DEPS))); }

  function addDep() {
    const err = $('dErr');
    const name = cleanName($('dNombre').value);
    const monto = parseFloat($('dMonto').value);
    const tasa = parseFloat($('dTasa').value || '0');
    const vence = $('dVence').value;
    let msg = '';
    if (!name) msg = 'Escribe el nombre de la entidad.';
    else if (!isNum(monto, 0.01, 1e9)) msg = 'Ingresa un monto válido.';
    else if (!isNum(tasa, 0, 30)) msg = 'La tasa debe estar entre 0% y 30%.';
    else if (vence && !DATE_RE.test(vence)) msg = 'Fecha de vencimiento no válida.';
    const deps = getDeps();
    if (!msg && deps.length >= MAX_DEPS) msg = 'Llegaste al máximo de ' + MAX_DEPS + ' registros.';
    if (msg) { err.textContent = msg; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    let id = Date.now();
    while (deps.some(function (d) { return d.id === id; })) id++;
    deps.push({ id: id, name: name, monto: monto, tasa: tasa, vence: vence || null });
    saveDeps(deps);
    ['dNombre', 'dMonto', 'dTasa', 'dVence'].forEach(function (i) { $(i).value = ''; });
    renderDeps();
  }

  function delDep(id) { saveDeps(getDeps().filter(function (d) { return d.id !== id; })); renderDeps(); }

  function renderDeps() {
    const deps = getDeps();
    const list = $('depList'), res = $('ahorrosResumen');
    list.replaceChildren();
    res.replaceChildren(el('h2', null, '📊 Resumen de mis ahorros'));
    if (!deps.length) {
      list.append(el('div', 'empty', ['Aún no registras depósitos.', el('br'), 'Agrega el primero arriba ☝️']));
      res.append(el('div', 'empty', 'Registra tus cuentas y depósitos para ver tu ganancia total y si le ganas a la inflación.'));
      return;
    }
    const infl = currentInflation();
    const total = deps.reduce(function (s, d) { return s + d.monto; }, 0);
    const anual = deps.reduce(function (s, d) { return s + d.monto * d.tasa / 100; }, 0);
    const prom = total > 0 ? anual / total * 100 : 0;
    const real = prom - infl;
    const hoy = new Date();
    deps.forEach(function (d) {
      if (!d.vence) return;
      const dias = Math.ceil((new Date(d.vence + 'T12:00:00') - hoy) / 86400000);
      if (dias >= 0 && dias <= 30) res.append(el('div', 'alert', ['⏰ Tu depósito en ', b(d.name), ' vence en ' + dias + ' día(s). ¡Renueva para no perder la tasa!']));
      else if (dias < 0) res.append(el('div', 'alert', ['⚠️ Tu depósito en ', b(d.name), ' ya venció. Probablemente está ganando casi 0%.']));
    });
    const line = function (label, valueNode) { return el('div', 'row', [el('span', 'sub', label), valueNode]); };
    res.append(
      line('Total ahorrado', el('span', 'big', fmtS(total))),
      line('Ganancia anual estimada', el('b', 'pos', fmtS(anual))),
      line('Tasa promedio', b(fmtPct(prom))),
      line('Vs. inflación (' + fmtPct(infl, 1) + ')', el('b', real >= 0 ? 'pos' : 'neg', (real >= 0 ? '+' : '') + fmtPct(real)))
    );
    deps.forEach(function (d) {
      const del = el('button', 'del', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', 'Eliminar ' + d.name);
      del.addEventListener('click', function () { if (window.confirm('¿Eliminar "' + d.name + '"?')) delDep(d.id); });
      list.append(el('div', 'dep', [
        el('div', null, [el('div', 'name', d.name), el('div', 'meta', 'TEA ' + fmtPct(d.tasa) + (d.vence ? ' · vence ' + d.vence : ''))]),
        el('div', 'right', [el('div', 'amt', [fmtS(d.monto), el('div', 'meta pos', '+' + fmtS(d.monto * d.tasa / 100) + '/año')]), del])
      ]));
    });
  }

  // ===================== INSTALACIÓN (PWA) =====================
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    const btn = $('installBtn');
    if (btn) btn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', function () { const btn = $('installBtn'); if (btn) btn.classList.add('hidden'); });

  // ===================== ARRANQUE =====================
  function renderAll() { renderStatus(); renderInicio(); renderRates(); renderGrati(); renderCts(); renderComp(); renderMeta(); renderDeps(); }

  function restoreInputs() {
    const m = parseFloat(store.get('monto', '25500'));
    if (isNum(m, 0, 1e9)) $('monto').value = String(m);
    const p = store.get('plazo', '12');
    if (['6', '12', '24', '36'].indexOf(p) >= 0) $('plazo').value = p;
    const t = parseFloat(store.get('miTasa', '0.33'));
    if (isNum(t, 0, 25)) $('miTasa').value = String(t);
  }

  function bind() {
    document.querySelectorAll('.tabbar button').forEach(function (bt) { bt.addEventListener('click', function () { go(bt.dataset.view); }); });
    document.querySelectorAll('[data-go]').forEach(function (bt) { bt.addEventListener('click', function () { go(bt.dataset.go); }); });
    document.querySelectorAll('.subtabs button').forEach(function (bt) { bt.addEventListener('click', function () { goSub(bt.dataset.sub); }); });
    ['monto', 'plazo', 'miTasa'].forEach(function (id) { $(id).addEventListener('input', renderRates); });
    ['gSueldo', 'gMeses', 'gReg'].forEach(function (id) { $(id).addEventListener('input', renderGrati); });
    ['cSueldo', 'cMeses'].forEach(function (id) { $(id).addEventListener('input', renderCts); });
    ['pIni', 'pAporte', 'pTasa', 'pAnios'].forEach(function (id) { $(id).addEventListener('input', renderComp); });
    ['mMeta', 'mIni', 'mAnios', 'mTasa'].forEach(function (id) { $(id).addEventListener('input', renderMeta); });
    $('dGuardar').addEventListener('click', addDep);
    $('installBtn').addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) { /* ignorar */ }
      deferredPrompt = null;
      $('installBtn').classList.add('hidden');
    });
    let rt = null;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { renderInicio(); renderComp(); }, 200); });
  }

  // Refresco automático: al abrir, al volver a la pestaña y cada 30 minutos si sigue abierta.
  let lastCheck = 0;
  function refresh() {
    lastCheck = Date.now();
    loadRemote().then(function (d) {
      if (!d) return;
      const changed = JSON.stringify(d) !== JSON.stringify(state.data);
      state.data = d; state.remote = true;
      if (changed) renderAll();
    });
  }

  function start() {
    restoreInputs();
    bind();
    renderAll();
    refresh();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > 10 * 60 * 1000) refresh();
    });
    setInterval(function () { if (document.visibilityState === 'visible') refresh(); }, 30 * 60 * 1000);
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function () { /* sin modo offline */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
