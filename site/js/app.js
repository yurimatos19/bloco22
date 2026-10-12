(function () {
  'use strict';

  var PRICE = 22.00;
  var SIZES = ['P', 'M', 'G', 'GG'];
  var LOW_STOCK = 20; // abaixo disso mostra "Últimas N"
  var ADDRESS = 'Avenida Herculano Bandeira, 766, Pina, Recife - PE';
  var MAPS_URL = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(ADDRESS);
  var API_URL = ((window.BLOCO22_CONFIG || {}).API_URL || '').trim();
  var DEMO = !API_URL;
  var STORAGE_KEY = 'bloco22:ultima-reserva';

  var stock = null; // saldo por tamanho vindo da planilha, ex.: { P: 150, M: 250, ... }
  var closed = false; // reservas encerradas pelo servidor (RESERVATIONS_OPEN = false)
  var selected = null;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('reserve-form');
  var sizesEl = $('sizes');
  var nameEl = $('name');
  var phoneEl = $('whatsapp');
  var consentEl = $('consent');
  var consentBox = $('consent-box');
  var submitEl = $('submit');
  var formError = $('form-error');
  var dock = $('dock');
  var dockBtn = $('dock-btn');
  var successEl = $('success');
  var lastReservation = null;

  var brl = function (v) { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
  // Cada pessoa reserva 1 camisa: o tamanho escolhido é a reserva.
  var total = function () { return selected ? 1 : 0; };
  var plural = function (n) { return n + (n === 1 ? ' camisa' : ' camisas'); };
  var buzz = function () { if (navigator.vibrate) navigator.vibrate(12); };

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  if (DEMO) $('demo-banner').hidden = false;
  document.querySelectorAll('.js-directions').forEach(function (a) { a.href = MAPS_URL; });

  /* ---------- Escolha do tamanho (1 camisa por pessoa) ---------- */
  var picker = $('picker');

  SIZES.forEach(function (s) {
    var label = el('label', { class: 'size' });
    var input = el('input', { type: 'radio', name: 'size', value: s, 'aria-label': 'Tamanho ' + s });
    var face = el('span', { class: 'size__face', 'aria-hidden': 'true' });
    face.append(el('b', null, s), el('small', { class: 'size__note' }));
    label.append(input, face);
    sizesEl.appendChild(label);
  });

  sizesEl.addEventListener('change', function (e) {
    selected = e.target.value;
    buzz();
    showFormError('');
    render();
  });

  function loadStock() {
    if (DEMO) return;
    fetch(API_URL).then(function (r) { return r.json(); }).then(function (d) {
      if (!d) return;
      closed = d.open === false;
      if (d.stock) stock = d.stock;
      render();
    }).catch(function () { /* sem saldo: o servidor confere na hora de reservar */ });
  }

  function render() {
    var soldAll = !!stock && SIZES.every(function (s) { return stock[s] === 0; });
    var blocked = closed || soldAll;

    // disponibilidade por tamanho
    sizesEl.querySelectorAll('.size').forEach(function (label) {
      var input = label.querySelector('input');
      var s = input.value;
      var soldOut = !!stock && stock[s] === 0;
      input.disabled = soldOut || blocked;
      label.classList.toggle('is-out', soldOut);
      var note = soldOut ? 'Esgotado' : stock && stock[s] <= LOW_STOCK ? 'Últimas ' + stock[s] : '';
      label.querySelector('.size__note').textContent = note;
      input.setAttribute('aria-label', 'Tamanho ' + s + (note ? ', ' + note.toLowerCase() : ''));
      if (input.disabled && selected === s) { selected = null; input.checked = false; }
    });

    var lim = $('limit-label');
    lim.textContent = closed ? 'As reservas pelo site foram encerradas.'
      : soldAll ? 'Todas as camisas já foram reservadas.'
      : '1 camisa por pessoa';
    lim.classList.toggle('full', blocked);

    var choice = $('choice');
    choice.textContent = closed ? 'As reservas pelo site foram encerradas.'
      : soldAll ? 'Todas as camisas já foram reservadas.'
      : selected ? 'Sua camisa: tamanho ' + selected + '. Para trocar, toque em outro tamanho.'
      : 'Toque no tamanho da sua camisa.';
    choice.classList.toggle('is-set', !!selected);

    submitEl.disabled = blocked;
    dockBtn.disabled = blocked;

    // totais
    $('sum-qty').textContent = selected ? 'Camisa tamanho ' + selected : 'Escolha o tamanho';
    $('sum-total').textContent = brl(PRICE);
    $('dock-qty').textContent = selected ? 'Camisa tamanho ' + selected : 'Camisa oficial';
    $('dock-total').textContent = brl(PRICE);
    dockBtn.textContent = closed ? 'Encerrado' : soldAll ? 'Esgotado' : selected ? 'Finalizar' : 'Reservar';
  }

  /* ---------- Campos ---------- */
  phoneEl.addEventListener('input', function () {
    var d = phoneEl.value.replace(/\D/g, '');
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    d = d.slice(0, 11);
    var out = d;
    if (d.length > 2) out = '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length > 7) out = '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
    phoneEl.value = out;
    clearFieldError(phoneEl);
  });
  nameEl.addEventListener('input', function () { clearFieldError(nameEl); });
  nameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); phoneEl.focus(); }
  });
  phoneEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); phoneEl.blur(); consentBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  consentEl.addEventListener('change', function () {
    consentBox.classList.toggle('is-on', consentEl.checked);
    consentBox.classList.remove('shake');
    if (consentEl.checked) { buzz(); showFormError(''); }
  });

  function validName(v) {
    v = v.replace(/\s+/g, ' ').trim();
    return v.length >= 5 && v.split(' ').length >= 2 && /^[\p{L}' .-]+$/u.test(v);
  }
  function validPhone(v) { return /^[1-9]{2}9\d{8}$/.test(v.replace(/\D/g, '')); }
  function setFieldError(input, msg) {
    var err = $(input.id + '-error');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', err.id + (input.id === 'whatsapp' ? ' whatsapp-hint' : ''));
    err.textContent = msg;
    err.hidden = false;
  }
  function clearFieldError(input) {
    input.removeAttribute('aria-invalid');
    $(input.id + '-error').hidden = true;
  }
  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = !msg;
  }
  function focusOn(node, focusIt) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (focusIt) setTimeout(function () { node.focus({ preventScroll: true }); }, 350);
  }

  // Retorna o primeiro problema do formulário (ou null) e marca os erros.
  function check(mark) {
    var first = null;
    if (total() < 1) {
      first = first || { node: picker, msg: 'Escolha o tamanho da camisa' };
    }
    if (!validName(nameEl.value)) {
      if (mark) setFieldError(nameEl, 'Digite seu nome e sobrenome.');
      first = first || { node: nameEl, focus: true };
    }
    if (!validPhone(phoneEl.value)) {
      if (mark) setFieldError(phoneEl, 'Digite um celular com DDD, como (81) 99999-9999.');
      first = first || { node: phoneEl, focus: true };
    }
    if (!consentEl.checked) {
      first = first || { node: consentBox, consent: true };
    }
    return first;
  }

  function guide(problem) {
    if (problem.msg) toast(problem.msg);
    if (problem.consent) {
      showFormError('Para concluir, marque que você está ciente de como funcionam o pagamento e a retirada.');
      consentBox.classList.remove('shake'); void consentBox.offsetWidth; consentBox.classList.add('shake');
    }
    focusOn(problem.node, problem.focus);
  }

  /* ---------- Envio ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitEl.classList.contains('is-loading')) return;
    showFormError('');
    var problem = check(true);
    if (problem) { guide(problem); return; }

    var items = {};
    items[selected] = 1;
    var payload = {
      name: nameEl.value.replace(/\s+/g, ' ').trim(),
      whatsapp: phoneEl.value.replace(/\D/g, ''),
      items: items,
      consent: consentEl.checked === true,
      website: $('website').value,
    };

    setLoading(true);
    send(payload)
      .then(function (res) {
        if (res && res.stock) { stock = res.stock; render(); }
        if (!res || !res.ok) throw new Error((res && res.error) || 'Não foi possível concluir sua reserva.');
        saveLocal(res);
        resetForm();
        showSuccess(res, true);
        loadStock();
      })
      .catch(function (err) {
        var msg = err && err.message && !/fetch|network|Load failed|JSON/i.test(err.message)
          ? err.message
          : 'Sem conexão com o sistema de reservas. Confira sua internet e toque em Confirmar reserva de novo.';
        showFormError(msg);
        focusOn(formError);
      })
      .finally(function () { setLoading(false); });
  });

  function send(payload) {
    if (DEMO) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', c = 'B22-';
          for (var i = 0; i < 5; i++) c += a[Math.floor(Math.random() * a.length)];
          var n = SIZES.reduce(function (t, s) { return t + (payload.items[s] || 0); }, 0);
          resolve({
            ok: true, code: c, name: payload.name, qty: n, total: Math.round(n * PRICE * 100) / 100,
            items: SIZES.filter(function (s) { return payload.items[s]; }).map(function (s) { return { size: s, qty: payload.items[s] }; }),
            createdAt: new Date().toISOString(),
          });
        }, 800);
      });
    }
    // text/plain evita o preflight CORS, que o Apps Script não suporta.
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    }).then(function (r) { return r.json(); });
  }

  function setLoading(on) {
    submitEl.classList.toggle('is-loading', on);
    submitEl.disabled = on;
    submitEl.querySelector('.btn__text').textContent = on ? 'Reservando…' : 'Confirmar reserva';
    if (!on) render(); // volta ao estado certo (ex.: esgotado)
  }

  function resetForm() {
    selected = null;
    form.reset();
    consentBox.classList.remove('is-on');
    render();
  }

  /* ---------- Barra fixa inferior ---------- */
  var heroCtaVisible = true, submitVisible = false;
  function updateDock() {
    var show = !heroCtaVisible && !submitVisible && successEl.hidden;
    dock.classList.toggle('show', show);
    dock.setAttribute('aria-hidden', String(!show));
    dockBtn.tabIndex = show ? 0 : -1;
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { heroCtaVisible = en[0].isIntersecting; updateDock(); })
      .observe(document.querySelector('.hero .btn'));
    new IntersectionObserver(function (en) { submitVisible = en[0].isIntersecting; updateDock(); })
      .observe(submitEl);
  }
  dockBtn.addEventListener('click', function () {
    if (total() === 0) { focusOn(picker); return; }
    var problem = check(false);
    if (problem) { guide(problem); return; }
    form.requestSubmit ? form.requestSubmit() : submitEl.click();
  });

  /* ---------- Contagem regressiva do bloco ---------- */
  (function () {
    var el = $('countdown');
    // Dias até 22/10/2026 no calendário de Recife
    var today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Recife' }));
    today.setHours(0, 0, 0, 0);
    var days = Math.round((new Date(2026, 9, 22) - today) / 864e5);
    if (days < 0) return;
    el.textContent = days === 0 ? 'É hoje!' : days === 1 ? 'É amanhã!' : 'Faltam ' + days + ' dias';
    el.hidden = false;
  })();

  /* ---------- Carrossel ---------- */
  var carousel = $('carousel');
  var slides = carousel.querySelectorAll('.slide');
  var dots = $('dots');
  slides.forEach(function () { dots.appendChild(el('i')); });
  function updateDots() {
    var idx = Math.round(carousel.scrollLeft / (slides[0].offsetWidth + 12));
    dots.querySelectorAll('i').forEach(function (d, i) { d.classList.toggle('on', i === Math.min(idx, slides.length - 1)); });
  }
  carousel.addEventListener('scroll', function () { requestAnimationFrame(updateDots); }, { passive: true });
  updateDots();

  /* ---------- Copiar endereço ---------- */
  document.querySelectorAll('.js-copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var txt = 'Comitê da Direita Pernambucana — Av. Herculano Bandeira, 766, Pina, Recife/PE';
      (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
        .then(function () { toast('Endereço copiado'); })
        .catch(function () { toast(txt); });
    });
  });

  /* ---------- Tela de sucesso ---------- */
  var lastFocus = null;

  function showSuccess(r, celebrate) {
    lastReservation = r;
    $('r-code').textContent = r.code;
    $('r-name').textContent = r.name ? 'Valeu, ' + r.name.split(' ')[0] + '! Mostre este código no Comitê.' : '';
    var list = $('r-items');
    list.replaceChildren();
    r.items.forEach(function (it) {
      var li = el('li');
      li.append(el('b', null, it.size), document.createTextNode(it.qty + '× ' + brl(it.qty * PRICE)));
      list.appendChild(li);
    });
    $('r-qty').textContent = plural(r.qty);
    $('r-total').textContent = brl(r.total);

    lastFocus = document.activeElement;
    successEl.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    successEl.querySelector('.success__scroll').scrollTop = 0;
    updateDock();
    $('btn-close').focus({ preventScroll: true });
    if (celebrate) { confetti(); if (navigator.vibrate) navigator.vibrate([30, 40, 30]); }
  }

  function closeSuccess() {
    successEl.hidden = true;
    document.documentElement.style.overflow = '';
    updateDock();
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  $('btn-close').addEventListener('click', closeSuccess);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !successEl.hidden) closeSuccess();
  });

  function confetti() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var c = $('confetti'), x = c.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = c.width = innerWidth * dpr, H = c.height = innerHeight * dpr;
    var colors = ['#FFD21F', '#0B7A35', '#FFFFFF', '#1FAF54', '#FFE066'];
    var parts = [];
    for (var i = 0; i < 140; i++) {
      parts.push({
        x: W / 2 + (Math.random() - .5) * W * .3, y: H * .28,
        vx: (Math.random() - .5) * 16 * dpr, vy: (-Math.random() * 14 - 6) * dpr,
        w: (6 + Math.random() * 6) * dpr, h: (10 + Math.random() * 8) * dpr,
        r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: colors[i % colors.length],
      });
    }
    var t0 = performance.now();
    (function frame(now) {
      var el2 = now - t0;
      x.clearRect(0, 0, W, H);
      parts.forEach(function (p) {
        p.vy += .45 * dpr; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        x.save(); x.translate(p.x, p.y); x.rotate(p.r);
        x.globalAlpha = Math.max(0, 1 - el2 / 2600);
        x.fillStyle = p.c; x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
        x.restore();
      });
      if (el2 < 2600) requestAnimationFrame(frame); else x.clearRect(0, 0, W, H);
    })(t0);
  }

  /* ---------- Comprovante (imagem PNG) ---------- */
  var logo = new Image();
  logo.src = 'img/logo.png';

  function shareText(r) {
    return '*Reserva Bloco do 22* — Código *' + r.code + '*\n' +
      r.items.map(function (i) { return i.qty + 'x ' + i.size; }).join(', ') +
      ' — Total ' + brl(r.total) + ' (pagar na retirada)\n\n' +
      'Pagamento e retirada SOMENTE no Comitê da Direita Pernambucana\n' +
      'Av. Herculano Bandeira, 766 — Pina, Recife/PE\n' +
      'Segunda a sábado, das 9h às 18h. Não há entregas.\n' + MAPS_URL;
  }

  function buildReceipt(r) {
    var W = 1080, P = 72, BOX = 380;
    var H = 730 + r.items.length * 56 + 78 + BOX + 56;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    var D = '"Bricolage Grotesque", "Arial Black", sans-serif';
    var B = 'Manrope, Arial, sans-serif';

    x.fillStyle = '#FFFFFF'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#053B1E'; x.fillRect(0, 0, W, 430);

    if (logo.complete && logo.naturalWidth) {
      var lw = 340, lh = lw * logo.naturalHeight / logo.naturalWidth;
      x.drawImage(logo, (W - lw) / 2, 36, lw, lh);
    }
    x.textAlign = 'center';
    x.fillStyle = '#FFFFFF';
    x.font = '800 62px ' + D;
    x.fillText('SUA CAMISA ESTÁ RESERVADA!', W / 2, 395);

    var y = 500;
    x.fillStyle = '#5B6A61'; x.font = '800 28px ' + B;
    x.fillText('CÓDIGO DA RESERVA', W / 2, y);
    x.fillStyle = '#075128'; x.font = '800 108px ' + D;
    x.fillText(r.code, W / 2, y + 105);
    x.fillStyle = '#0F1D15'; x.font = '700 34px ' + B;
    x.fillText(r.name, W / 2, y + 160);

    y += 230;
    x.textAlign = 'left'; x.font = '700 36px ' + B; x.fillStyle = '#0F1D15';
    r.items.forEach(function (it) {
      x.fillText(it.qty + 'x  Camisa tamanho ' + it.size, P, y);
      x.textAlign = 'right'; x.fillText(brl(it.qty * PRICE), W - P, y); x.textAlign = 'left';
      y += 56;
    });
    x.strokeStyle = '#C9D4CC'; x.setLineDash([10, 8]); x.lineWidth = 2;
    x.beginPath(); x.moveTo(P, y - 20); x.lineTo(W - P, y - 20); x.stroke(); x.setLineDash([]);
    y += 28;
    x.font = '800 48px ' + D; x.fillStyle = '#053B1E';
    x.fillText('TOTAL', P, y);
    x.textAlign = 'right'; x.fillText(brl(r.total), W - P, y); x.textAlign = 'left';

    y += 50;
    x.fillStyle = '#FFD21F'; roundRect(x, P - 20, y, W - 2 * (P - 20), BOX, 28); x.fill();
    x.strokeStyle = '#1D3B9A'; x.lineWidth = 8; x.stroke();
    x.fillStyle = '#14246B'; x.font = '800 50px ' + D; x.textAlign = 'center';
    x.fillText('ONDE PAGAR E RETIRAR?', W / 2, y + 74);
    x.fillStyle = '#032814'; x.font = '800 40px ' + B;
    x.fillText('Comitê da Direita Pernambucana', W / 2, y + 140);
    x.font = '600 34px ' + B;
    x.fillText('Av. Herculano Bandeira, 766 — Pina, Recife/PE', W / 2, y + 190);
    x.fillText('Segunda a sábado, das 9h às 18h', W / 2, y + 236);
    x.font = '800 30px ' + B;
    wrap(x, 'Sua camisa NÃO foi paga pelo site. O pagamento é feito no momento da retirada. Não fazemos entregas.', W / 2, y + 300, W - 2 * P - 40, 42);
    return c;
  }

  function roundRect(x, l, t, w, h, r) {
    x.beginPath();
    x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r);
    x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath();
  }
  function wrap(x, text, cx, y, maxW, lh) {
    var line = '';
    text.split(' ').forEach(function (w) {
      var test = line ? line + ' ' + w : w;
      if (x.measureText(test).width > maxW && line) { x.fillText(line, cx, y); line = w; y += lh; }
      else line = test;
    });
    if (line) x.fillText(line, cx, y);
  }

  function receiptBlob(r) {
    return (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
      return new Promise(function (resolve) { buildReceipt(r).toBlob(resolve, 'image/png'); });
    });
  }
  function receiptFile(r) {
    return receiptBlob(r).then(function (blob) {
      return new File([blob], 'reserva-bloco22-' + r.code + '.png', { type: 'image/png' });
    });
  }

  // No celular, "Salvar" abre o menu nativo (Salvar imagem / Fotos); no computador, baixa o PNG.
  $('btn-save').addEventListener('click', function () {
    var r = lastReservation;
    if (!r) return;
    receiptFile(r).then(function (file) {
      var mobile = matchMedia('(pointer: coarse)').matches;
      if (mobile && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file] });
      }
      var url = URL.createObjectURL(file);
      var a = el('a', { href: url, download: file.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Comprovante salvo nos downloads');
    }).catch(function () { /* cancelado */ });
  });

  $('btn-share').addEventListener('click', function () {
    var r = lastReservation;
    if (!r) return;
    var text = shareText(r);
    receiptFile(r).then(function (file) {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], text: text });
      }
      if (navigator.share) return navigator.share({ text: text });
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    }).catch(function () { /* cancelado */ });
  });

  /* ---------- Última reserva salva no aparelho ---------- */
  function saveLocal(r) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(r)); } catch (e) { /* sem storage */ }
    addReopen(r);
  }
  function addReopen(r) {
    var slot = $('reopen-slot');
    slot.replaceChildren();
    var b = el('button', { type: 'button', class: 'reopen' });
    b.append(el('span', null, 'Você já reservou sua camisa neste celular.'), el('b', null, 'Ver reserva ' + r.code));
    b.addEventListener('click', function () { showSuccess(r, false); });
    slot.appendChild(b);
  }
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.code && Array.isArray(saved.items)) addReopen(saved);
  } catch (e) { /* sem storage */ }

  render();
  loadStock();
})();
