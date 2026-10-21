/**
 * BLOCO DO 22 — Sistema de reservas (Google Apps Script)
 *
 * Planilha "Bloco do 22 — Reservas de camisas":
 *   • Painel         — números do dia e estoque por tamanho (só fórmulas)
 *   • Balcão         — busca por código ou WhatsApp e caixa "Entregue" para o atendente
 *   • Reservas       — 1 linha por pedido; colunas P, M, G, GG; Status Reservado/Entregue/Cancelado
 *   • Configurações  — preço, máximo por reserva, reservas abertas e estoque por tamanho
 *   • Como usar      — guia da equipe
 *
 * O site envia a reserva → o script valida, confere o estoque e grava em Reservas.
 * Cancelar uma reserva (Status = Cancelado) devolve as camisas ao estoque.
 * Limite por pessoa: cada WhatsApp pode ter no total CFG_MAX camisas em reservas ativas.
 * Retirada: começa em PICKUP_START (domingo, 18/10, às 11h); depois, todos os dias das 9h às 18h.
 * Validade: quem reservou até 18/10 tem até 20/10, às 18h. A partir de 19/10, 1 dia: até as 18h do dia seguinte.
 * Camisas não retiradas no prazo voltam ao estoque e podem ser reservadas de novo (até LAST_PICKUP_DAY).
 * Vencida → Status "Expirado" (automático, de hora em hora), as camisas voltam ao estoque e a
 * pessoa pode reservar de novo.
 *
 * RESERVAS PELO SUPABASE (desde 20/10): o site reserva direto no banco de dados Supabase, que
 * aguenta milhares de acessos. A cada 1 minuto, `sincronizarSupabase` traz as reservas novas para
 * a aba Reservas e devolve ao Supabase o saldo real (estoque − reservas ativas da planilha), os
 * WhatsApps com reserva ativa e se as reservas estão abertas (caixa da aba Configurações).
 * Para ligar: rode `conectarSupabase` uma vez.
 *
 * INSTALAÇÃO (uma vez): cole este código, rode `ativar` e depois publique uma nova versão
 * em Implantar → Gerenciar implantações (a URL do site não muda).
 */

const APP = {
  // Planilha "Bloco do 22 — Reservas de camisas" (ID que aparece na URL dela)
  SPREADSHEET_ID: '1mjnLKelq4nEKKi9UhNNnodgJvK9-_zIo6tKXsoFxssM',
  SIZES: ['P', 'M', 'G', 'GG'],
  SHEETS: { PAINEL: 'Painel', BALCAO: 'Balcão', BALCOES: ['Balcão 1', 'Balcão 2', 'Balcão 3'], VENDAS: ['Venda 1', 'Venda 2'], RESERVAS: 'Reservas', CONFIG: 'Configurações', GUIA: 'Como usar' },
  STATUS: { RESERVADO: 'Reservado', ENTREGUE: 'Entregue', CANCELADO: 'Cancelado', EXPIRADO: 'Expirado' },
  HOLD_DAYS: 1,                 // dias de validade a partir da reserva, limitado a LAST_PICKUP_DAY (até 18/10 eram 2)
  PICKUP_START: '2026-10-18',   // primeiro dia de retirada no Comitê (domingo)
  PICKUP_START_HOUR: 11,        // no primeiro dia, a entrega começa às 11h
  PICKUP_HOUR: 18,              // a reserva vence às 18h do último dia
  LAST_PICKUP_DAY: '2026-10-22', // nenhum prazo passa do dia do evento; depois das 18h o site fecha
  TZ: 'America/Recife',
  // Valores iniciais da aba Configurações (depois a equipe edita lá mesmo)
  DEFAULTS: {
    price: 22,
    max: 1, // camisas por pessoa (por WhatsApp), somando todas as reservas não canceladas
    stock: { P: 150, M: 250, G: 400, GG: 200 },
    local: 'Comitê da Direita Pernambucana',
    endereco: 'Av. Herculano Bandeira, 766 — Pina, Recife/PE',
    horario: 'Das 9h às 18h, a partir de domingo, 18/10, às 11h',
    evento: 'Quinta-feira, 22/10/2026, às 19h, na Pracinha de Boa Viagem',
  },
  CODE_PREFIX: 'B22-',
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // sem 0/O/1/I
  CODE_LENGTH: 5,
  // Anti-abuso: no máximo N reservas concluídas por WhatsApp a cada janela de tempo
  RATE_LIMIT_MAX: 3,
  RATE_LIMIT_WINDOW_SEC: 60 * 60,
};

// Paleta (verde, amarelo e azul — sem vermelho)
const COLOR = {
  green900: '#032814', green800: '#053B1E', green600: '#0B7A35', green100: '#E6F4EA',
  yellow: '#FFD21F', yellow50: '#FFF8D6', blue: '#1D3B9A', blue50: '#E9EEFB',
  paper: '#F2F6F0', line: '#D5DED8', muted: '#5B6A61', grey: '#9AA59E',
};

// Colunas da aba Reservas (1 = A)
const COL = { CODIGO: 1, DATA: 2, NOME: 3, WHATS: 4, P: 5, M: 6, G: 7, GG: 8, QTD: 9, TOTAL: 10, STATUS: 11, ATENDENTE: 12, RETIRADA: 13, OBS: 14, PRAZO: 15 };
const HEADERS = ['Código', 'Reservado em', 'Nome completo', 'WhatsApp', 'P', 'M', 'G', 'GG', 'Qtd.', 'Total', 'Status', 'Atendente', 'Retirado em', 'Observações', 'Retirar até'];
const NCOLS = HEADERS.length;

/* ------------------------------------------------------------------ */
/* Endpoints do site                                                  */
/* ------------------------------------------------------------------ */

function doGet() {
  const s = settings_();
  return json_({ ok: true, open: s.open, price: s.price, max: s.max, stock: remaining_(s.stock) });
}

// O site agora reserva pelo Supabase. Páginas antigas, ainda abertas, caem aqui: pede para recarregar.
function doPost(e) {
  return json_({ ok: false, error: 'O site foi atualizado. Recarregue a página e toque em Confirmar reserva de novo.' });
}

function doPostPlanilha_(e) {
  try {
    const s = settings_();
    if (!s.open) return json_({ ok: false, error: 'As reservas estão encerradas no momento.' });

    let data;
    try {
      data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      return json_({ ok: false, error: 'Requisição inválida.' });
    }

    // Honeypot: robôs preenchem campos ocultos.
    if (data.website) return json_({ ok: false, error: 'Requisição inválida.' });

    const v = validate_(data, s.max);
    if (v.error) return json_({ ok: false, error: v.error });

    if (!checkRateLimit_(v.phone)) {
      return json_({ ok: false, error: 'Muitas reservas para este WhatsApp em pouco tempo. Tente novamente mais tarde.' });
    }

    // Uma reserva por vez (evita estoque a mais e código repetido). Se a fila estiver longa,
    // responde "ocupado" sem gravar nada, e o site tenta de novo sozinho.
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(28000)) {
      return json_({ ok: false, busy: true, error: 'Muita gente reservando agora. Tente de novo em alguns segundos.' });
    }
    try {
      // Limite por pessoa: soma o que esse WhatsApp já tem em reservas não canceladas.
      const already = shirtsByPhone_(v.phone);
      if (already + v.qty > s.max) {
        return json_({
          ok: false,
          error: already > 0
            ? 'Esse WhatsApp já tem uma reserva. É ' + (s.max === 1 ? '1 camisa' : 'no máximo ' + s.max + ' camisas') +
              ' por pessoa. Se perdeu o código, informe seu WhatsApp no Comitê na hora da retirada.'
            : 'O limite é de ' + s.max + (s.max === 1 ? ' camisa' : ' camisas') + ' por pessoa.',
        });
      }

      // Confere o estoque dentro da trava, para reservas simultâneas não passarem do limite.
      const left = remaining_(s.stock);
      for (const size of Object.keys(v.items)) {
        if (v.items[size] > left[size]) {
          return json_({
            ok: false,
            error: left[size] === 0
              ? 'O tamanho ' + size + ' esgotou. Remova do carrinho e escolha outro tamanho.'
              : 'Só ' + (left[size] === 1 ? 'resta 1 camisa' : 'restam ' + left[size] + ' camisas') + ' no tamanho ' + size + '. Ajuste o carrinho e tente de novo.',
            stock: left,
          });
        }
      }
      const reservation = saveReservation_(v, s.price);
      countReservation_(v.phone);
      return json_(Object.assign({ ok: true }, reservation));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
    return json_({
      ok: false,
      error: 'Não foi possível registrar sua reserva agora. Tente novamente em instantes.',
      detalhe: String(err && err.message || err), // ajuda no diagnóstico (não contém dados pessoais)
    });
  }
}

/* ------------------------------------------------------------------ */
/* Reservas                                                           */
/* ------------------------------------------------------------------ */

function saveReservation_(v, price) {
  const sh = sheet_(APP.SHEETS.RESERVAS);
  const code = uniqueCode_(sh);
  const now = new Date();
  const total = Math.round(v.qty * price * 100) / 100;
  const deadline = deadline_(now);

  const row = sh.getLastRow() + 1;
  sh.getRange(row, COL.PRAZO).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(row, COL.WHATS).setNumberFormat('@');
  sh.getRange(row, COL.DATA).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(row, COL.RETIRADA).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(row, COL.TOTAL).setNumberFormat('"R$" #,##0.00');
  sh.getRange(row, COL.P, 1, 5).setHorizontalAlignment('center');
  sh.getRange(row, COL.CODIGO).setFontWeight('bold');
  sh.getRange(row, 1, 1, NCOLS).setValues([[
    code, horaRecife_(now), safe_(v.name), formatPhone_(v.phone),
    ...APP.SIZES.map(sz => v.items[sz] || ''),
    v.qty, total, APP.STATUS.RESERVADO, '', '', '', deadline.sheet,
  ]]);
  SpreadsheetApp.flush();

  return {
    code: code,
    name: v.name,
    items: APP.SIZES.filter(sz => v.items[sz]).map(sz => ({ size: sz, qty: v.items[sz] })),
    qty: v.qty,
    total: total,
    createdAt: now.toISOString(),
    deadline: deadline.label,   // ex.: "sáb, 17/10, às 18h"
    deadlineAt: deadline.iso,
    pickupFrom: deadline.from,  // ex.: "dom, 18/10, às 11h" (vazio se a retirada já começou)
  };
}

// Prazo de retirada: (dia da reserva ou início da retirada, o que vier depois) + HOLD_DAYS, às 18h,
// no máximo no dia do evento. Se a retirada ainda não começou, informa a data de início.
function deadline_(now) {
  const utc = s => { const [a, b, c] = s.split('-').map(Number); return new Date(Date.UTC(a, b - 1, c)); };
  const today = utc(Utilities.formatDate(now, APP.TZ, 'yyyy-MM-dd'));
  const start = utc(APP.PICKUP_START);
  const startAt = new Date(APP.PICKUP_START + 'T' + String(APP.PICKUP_START_HOUR).padStart(2, '0') + ':00:00-03:00');
  const from = start > today ? start : today;
  const day = new Date(from.getTime());
  day.setUTCDate(day.getUTCDate() + APP.HOLD_DAYS);
  const last = utc(APP.LAST_PICKUP_DAY);
  if (day > last) day.setTime(last.getTime());
  const pad = n => String(n).padStart(2, '0');
  const ymd = day.getUTCFullYear() + '-' + pad(day.getUTCMonth() + 1) + '-' + pad(day.getUTCDate());
  const hh = pad(APP.PICKUP_HOUR);
  const weekdays = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const short = dt => weekdays[dt.getUTCDay()] + ', ' + pad(dt.getUTCDate()) + '/' + pad(dt.getUTCMonth() + 1);
  return {
    from: now < startAt ? short(start) + ', às ' + APP.PICKUP_START_HOUR + 'h' : '', // ex.: "dom, 18/10, às 11h" 
    sheet: ymd + ' ' + hh + ':00:00',                         // gravado na planilha (horário de Recife)
    iso: ymd + 'T' + hh + ':00:00-03:00',                     // para o site
    label: short(day) + ', às ' + APP.PICKUP_HOUR + 'h',
    date: new Date(ymd + 'T' + hh + ':00:00-03:00'),
  };
}

// Depois das 18h do último dia de retirada não faz sentido reservar: o site fecha sozinho.
function pickupOver_(now) {
  return now.getTime() > new Date(APP.LAST_PICKUP_DAY + 'T' + String(APP.PICKUP_HOUR).padStart(2, '0') + ':00:00-03:00').getTime();
}

// Reserva ainda vale? (Reservado e dentro do prazo)
function isActive_(row, now) {
  const status = row[COL.STATUS - 1];
  if (!row[COL.CODIGO - 1]) return false;
  if (isValue_(status, APP.STATUS.ENTREGUE)) return true;
  if (!isValue_(status, APP.STATUS.RESERVADO)) return false; // Cancelado ou Expirado
  return !isPastDeadline_(row[COL.PRAZO - 1], now);
}

function isPastDeadline_(prazo, now) {
  if (!prazo) return false;
  const d = prazo instanceof Date ? prazo : new Date(String(prazo).replace(' ', 'T') + '-03:00');
  return !isNaN(d) && d.getTime() < now.getTime();
}

/**
 * Recalcula o "Retirar até" das reservas ainda pendentes com a regra atual (ex.: quando a data de
 * início da entrega muda). Usa a data em que cada reserva foi feita. Rodado pela ativar.
 */
function recalcularPrazos_() {
  const sh = sheet_(APP.SHEETS.RESERVAS);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const rows = sh.getRange(2, 1, last - 1, NCOLS).getValues();
  const prazos = sh.getRange(2, COL.PRAZO, last - 1, 1);
  const out = prazos.getValues();
  let n = 0;
  rows.forEach((r, i) => {
    if (!r[COL.CODIGO - 1] || !isValue_(r[COL.STATUS - 1], APP.STATUS.RESERVADO)) return;
    const at = r[COL.DATA - 1] instanceof Date ? r[COL.DATA - 1] : new Date(String(r[COL.DATA - 1]).replace(' ', 'T') + '-03:00');
    if (isNaN(at)) return;
    out[i][0] = deadline_(at).sheet;
    n++;
  });
  prazos.setNumberFormat('dd/MM/yyyy HH:mm').setValues(out);
  Logger.log('Prazos recalculados: %s reserva(s) pendente(s).', n);
  return n;
}

/** Gatilho de hora em hora (instalado por ativar): marca como Expirado as reservas vencidas. */
function expirarReservas() {
  const sh = sheet_(APP.SHEETS.RESERVAS);
  const last = sh.getLastRow();
  if (last < 2) return;
  const now = new Date();
  const status = sh.getRange(2, COL.STATUS, last - 1, 1);
  const st = status.getValues();
  const prazos = sh.getRange(2, COL.PRAZO, last - 1, 1).getValues();
  let changed = 0;
  st.forEach((r, i) => {
    if (isValue_(r[0], APP.STATUS.RESERVADO) && isPastDeadline_(prazos[i][0], now)) { r[0] = APP.STATUS.EXPIRADO; changed++; }
  });
  if (changed) status.setValues(st);
}

// Camisas que um WhatsApp já tem em reservas ativas (não canceladas nem vencidas).
function shirtsByPhone_(phone) {
  const sh = sheet_(APP.SHEETS.RESERVAS);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  let total = 0;
  const now = new Date();
  sh.getRange(2, 1, last - 1, NCOLS).getValues().forEach(r => {
    if (!isActive_(r, now)) return;
    if (String(r[COL.WHATS - 1]).replace(/\D/g, '').slice(-11) === phone) total += Number(r[COL.QTD - 1]) || 0;
  });
  return total;
}

// Saldo por tamanho = estoque − camisas em reservas ativas (entregues ou dentro do prazo).
function remaining_(stock) {
  const sh = sheet_(APP.SHEETS.RESERVAS);
  const last = sh.getLastRow();
  const used = {};
  APP.SIZES.forEach(sz => { used[sz] = 0; });
  if (last >= 2) {
    const now = new Date();
    sh.getRange(2, 1, last - 1, NCOLS).getValues().forEach(r => {
      if (!isActive_(r, now)) return;
      APP.SIZES.forEach(sz => { used[sz] += Number(r[COL[sz] - 1]) || 0; });
    });
  }
  const left = {};
  APP.SIZES.forEach(sz => { left[sz] = Math.max(0, (stock[sz] || 0) - used[sz]); });
  return left;
}

function uniqueCode_(sh) {
  const last = sh.getLastRow();
  const existing = new Set(last >= 2 ? sh.getRange(2, COL.CODIGO, last - 1, 1).getValues().map(r => r[0]) : []);
  for (let i = 0; i < 50; i++) {
    let c = APP.CODE_PREFIX;
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let j = 0; j < APP.CODE_LENGTH; j++) {
      c += APP.CODE_ALPHABET[parseInt(hex.substr(j * 2, 2), 16) % APP.CODE_ALPHABET.length];
    }
    if (!existing.has(c)) return c;
  }
  throw new Error('Falha ao gerar código único');
}

// Lê a aba Configurações (intervalos nomeados), com valores padrão de segurança.
function settings_() {
  const ss = ss_();
  const named = n => ss.getRangeByName(n);
  const num = (n, def) => {
    const r = named(n);
    const v = r ? Number(String(r.getValue()).replace(',', '.')) : NaN;
    return v > 0 ? v : def;
  };
  const stock = {};
  APP.SIZES.forEach(sz => { stock[sz] = 0; });
  const st = named('CFG_ESTOQUE');
  if (st) {
    st.getValues().forEach(([sz, q]) => {
      sz = String(sz).trim().toUpperCase();
      if (sz in stock) stock[sz] = Math.max(0, Math.floor(Number(q) || 0));
    });
  } else {
    Object.assign(stock, APP.DEFAULTS.stock);
  }
  const open = named('CFG_ABERTAS');
  return {
    price: num('CFG_PRECO', APP.DEFAULTS.price),
    max: Math.floor(num('CFG_MAX', APP.DEFAULTS.max)),
    open: (open ? isOn_(open.getValue()) : true) && !pickupOver_(new Date()),
    stock: stock,
  };
}

/* ------------------------------------------------------------------ */
/* Validação                                                          */
/* ------------------------------------------------------------------ */

function validate_(d, maxPerOrder) {
  const name = String(d.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 5 || name.length > 120 || name.split(' ').length < 2) {
    return { error: 'Informe seu nome completo (nome e sobrenome).' };
  }
  if (!/^[\p{L}' .-]+$/u.test(name)) {
    return { error: 'O nome contém caracteres inválidos.' };
  }

  let phone = String(d.whatsapp || '').replace(/\D/g, '');
  if (phone.length === 13 && phone.startsWith('55')) phone = phone.slice(2);
  if (!/^[1-9]{2}9\d{8}$/.test(phone)) {
    return { error: 'Informe um WhatsApp válido com DDD, ex.: (81) 99999-9999.' };
  }

  const items = {};
  let qty = 0;
  const raw = d.items && typeof d.items === 'object' ? d.items : {};
  for (const k of Object.keys(raw)) {
    const n = Number(raw[k]);
    if (APP.SIZES.indexOf(k) === -1 || !Number.isInteger(n) || n < 0) {
      return { error: 'Tamanho ou quantidade inválida.' };
    }
    if (n > 0) {
      items[k] = n;
      qty += n;
    }
  }
  if (qty < 1) return { error: 'Escolha pelo menos 1 camisa.' };
  if (qty > maxPerOrder) return { error: 'O limite é de ' + maxPerOrder + (maxPerOrder === 1 ? ' camisa' : ' camisas') + ' por pessoa.' };

  if (d.consent !== true) {
    return { error: 'Você precisa confirmar que está ciente das condições de pagamento e retirada.' };
  }

  return { name: name, phone: phone, items: items, qty: qty };
}

// Só reservas concluídas contam para o limite (tentativas recusadas não).
function checkRateLimit_(phone) {
  return Number(CacheService.getScriptCache().get('rl_' + phone) || 0) < APP.RATE_LIMIT_MAX;
}

function countReservation_(phone) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + phone;
  cache.put(key, String(Number(cache.get(key) || 0) + 1), APP.RATE_LIMIT_WINDOW_SEC);
}

/* ------------------------------------------------------------------ */
/* Automação na planilha (gatilho instalado por ativar)              */
/* ------------------------------------------------------------------ */

function aoEditar(e) {
  const name = e.range.getSheet().getName();
  if (name === APP.SHEETS.RESERVAS) return onReservasEdit_(e);
  if (name === APP.SHEETS.BALCAO || APP.SHEETS.BALCOES.indexOf(name) !== -1) return onBalcaoEdit_(e);
  if (APP.SHEETS.VENDAS.indexOf(name) !== -1) return onVendaEdit_(e);
}

// Status = Entregue → preenche "Retirado em". Voltou para Reservado/Cancelado → limpa.
function onReservasEdit_(e) {
  const range = e.range;
  if (range.getColumn() > COL.STATUS || range.getLastColumn() < COL.STATUS) return;
  const sh = range.getSheet();
  const first = Math.max(range.getRow(), 2);
  const last = range.getLastRow();
  if (last < first) return;
  const n = last - first + 1;
  const codes = sh.getRange(first, COL.CODIGO, n, 1).getValues();
  const status = sh.getRange(first, COL.STATUS, n, 1).getValues();
  const dates = sh.getRange(first, COL.RETIRADA, n, 1);
  const out = dates.getValues().map((r, i) => {
    if (!codes[i][0]) return [r[0]];
    if (isValue_(status[i][0], APP.STATUS.ENTREGUE)) return [r[0] || horaRecife_(new Date())];
    return [''];
  });
  dates.setValues(out);
}

// Balcão: marcar a caixa "Entregue" (B5) dá baixa na reserva buscada.
function onBalcaoEdit_(e) {
  const sh = e.range.getSheet();
  if (e.range.getA1Notation() !== 'B5' || !isOn_(e.range.getValue())) return;
  const isBox = typeof e.range.getValue() === 'boolean';

  const say = (msg, ok) => sh.getRange('B6')
    .setValue(msg)
    .setBackground(ok ? COLOR.green100 : COLOR.blue50)
    .setFontColor(ok ? COLOR.green800 : COLOR.blue);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const query = String(sh.getRange('B3').getValue()).trim();
    const attendant = String(sh.getRange('B4').getValue()).trim();
    if (!query) return say('Digite o código ou o WhatsApp da reserva antes de marcar a caixa.', false);
    if (!attendant) return say('Escreva o nome do atendente antes de marcar a caixa.', false);

    const rs = sheet_(APP.SHEETS.RESERVAS);
    const last = rs.getLastRow();
    if (last < 2) return say('Ainda não há reservas.', false);
    const rows = rs.getRange(2, 1, last - 1, NCOLS).getValues();

    const code = query.toUpperCase();
    const digits = query.replace(/\D/g, '');
    const byPhone = digits.length >= 8;
    const found = [];
    rows.forEach((r, i) => {
      const matches = r[COL.CODIGO - 1] === code ||
        (byPhone && String(r[COL.WHATS - 1]).replace(/\D/g, '').slice(-digits.length) === digits);
      if (matches && !isValue_(r[COL.STATUS - 1], APP.STATUS.CANCELADO)) found.push({ row: i + 2, data: r });
    });

    if (!found.length) return say('Nenhuma reserva ativa encontrada para "' + query + '". Confira o código ou o número.', false);
    const now = new Date();
    const delivered = found.filter(f => isValue_(f.data[COL.STATUS - 1], APP.STATUS.ENTREGUE));
    const pending = found.filter(f => isValue_(f.data[COL.STATUS - 1], APP.STATUS.RESERVADO) && !isPastDeadline_(f.data[COL.PRAZO - 1], now));
    if (!pending.length) {
      if (delivered.length) {
        const f = delivered[delivered.length - 1].data;
        return say('Essa reserva já foi entregue' + (f[COL.ATENDENTE - 1] ? ' por ' + f[COL.ATENDENTE - 1] : '') + '. Não entregue de novo.', false);
      }
      return say('Essa reserva venceu (o prazo de retirada passou). Peça para a pessoa reservar de novo pelo site, se ainda houver o tamanho.', false);
    }
    if (pending.length > 1) {
      return say('Esse WhatsApp tem ' + pending.length + ' reservas pendentes. Digite o código da reserva para dar baixa na certa.', false);
    }

    const f = pending[0];
    rs.getRange(f.row, COL.STATUS, 1, 3).setValues([[APP.STATUS.ENTREGUE, attendant, horaRecife_(new Date())]]);
    const resumo = APP.SIZES.filter(sz => f.data[COL[sz] - 1]).map(sz => f.data[COL[sz] - 1] + 'x ' + sz).join(', ');
    say('Entregue: ' + f.data[COL.CODIGO - 1] + ' — ' + f.data[COL.NOME - 1] + ' (' + resumo + '). Valor recebido: R$ ' +
      Number(f.data[COL.TOTAL - 1]).toFixed(2).replace('.', ',') + '.', true);
  } finally {
    sh.getRange('B5').setValue(isBox ? false : 'Não');
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Ativação da planilha                                               */
/* ------------------------------------------------------------------ */

/**
 * RODE UMA VEZ pelo editor (pode rodar de novo sem problema). Liga o site à planilha:
 * acerta fuso e idioma, cria as caixinhas de marcar, (re)escreve as fórmulas do Painel e do
 * Balcão, adiciona os avisos de proteção e instala a automação do Balcão e do Status.
 */
function ativar() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(APP.TZ);
  // As fórmulas abaixo usam vírgula como separador (padrão em inglês). Em português o separador é
  // ";" e a vírgula vira decimal, o que quebra tudo (#ERROR!). Por isso escrevemos tudo com a
  // planilha em inglês e, no fim, voltamos para português: o Google converte as fórmulas sozinho.
  ss.setSpreadsheetLocale('en_US');
  SpreadsheetApp.flush();
  try {
    ativarConteudo_(ss);
  } finally {
    SpreadsheetApp.flush();
    ss.setSpreadsheetLocale('pt_BR');
    SpreadsheetApp.flush();
  }

  const s = settings_();
  Logger.log('Planilha ativada ✅  %s', ss.getUrl());
  Logger.log('Preço R$ %s, máximo %s por pessoa, reservas abertas: %s', s.price, s.max, s.open ? 'sim' : 'não');
  Logger.log('Saldo: %s', JSON.stringify(remaining_(s.stock)));
}

function ativarConteudo_(ss) {

  // Configurações: intervalos nomeados, caixa "Reservas abertas" e total do estoque
  const cfg = sheet_(APP.SHEETS.CONFIG);
  named_(ss, 'CFG_PRECO', cfg.getRange('B5'));
  named_(ss, 'CFG_MAX', cfg.getRange('B6'));
  named_(ss, 'CFG_ABERTAS', cfg.getRange('B7'));
  named_(ss, 'CFG_ESTOQUE', cfg.getRange('A11:B14'));
  checkbox_(cfg.getRange('B7'), isOn_(cfg.getRange('B7').getValue()));
  const maxLabel = 'Camisas por pessoa (por WhatsApp)';
  if (cfg.getRange('A6').getValue() !== maxLabel) {
    cfg.getRange('A6').setValue(maxLabel);
    cfg.getRange('B6').setValue(APP.DEFAULTS.max);
    cfg.getRange('C6').setValue('Soma todas as reservas não canceladas do mesmo WhatsApp.');
  }
  cfg.getRange('B15').setFormula('=SUM(B11:B14)');

  // Balcões (um por atendente): caixa "Entregue" e busca
  const balcoes = balcoes_(ss);
  balcoes.forEach(bal => {
  checkbox_(bal.getRange('B5'), false);
  bal.getRange('A9').setFormula(
    '=ARRAYFORMULA(IF($B$3="","",IFERROR(FILTER(Reservas!A2:O,' +
      '(Reservas!A2:A=UPPER(TRIM($B$3)))+' +
      'IF(LEN(REGEXREPLACE($B$3&"","\\D",""))>=8,RIGHT(REGEXREPLACE(Reservas!D2:D&"","\\D",""),LEN(REGEXREPLACE($B$3&"","\\D","")))=REGEXREPLACE($B$3&"","\\D",""),FALSE)' +
      '),"Nenhuma reserva encontrada para esse código ou WhatsApp.")))');

  bal.getRange(8, COL.PRAZO).setValue('Retirar até');
  bal.getRange(8, COL.OBS).copyFormatToRange(bal, COL.PRAZO, COL.PRAZO, 8, 8);
  bal.getRange(9, COL.OBS, 20, 1).copyFormatToRange(bal, COL.PRAZO, COL.PRAZO, 9, 28);
  bal.getRange(9, COL.PRAZO, 20, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  bal.setColumnWidth(COL.PRAZO, 140);
  });

  // Painel: todas as fórmulas
  const painel = sheet_(APP.SHEETS.PAINEL);
  painelFormulas_(painel);
  painel.getRange('G8').setValue('Canceladas ou vencidas');

  // Reservas: coluna "Retirar até", status Expirado, cores e filtro
  const rs = sheet_(APP.SHEETS.RESERVAS);
  if (rs.getMaxColumns() < NCOLS) rs.insertColumnsAfter(rs.getMaxColumns(), NCOLS - rs.getMaxColumns());
  rs.getRange(1, COL.PRAZO).setValue('Retirar até');
  rs.getRange(1, COL.OBS).copyFormatToRange(rs, COL.PRAZO, COL.PRAZO, 1, 1);
  rs.getRange(2, COL.PRAZO, rs.getMaxRows() - 1, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  rs.setColumnWidth(COL.PRAZO, 140);
  const statusCol = rs.getRange(2, COL.STATUS, rs.getMaxRows() - 1, 1);
  statusCol.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList([APP.STATUS.RESERVADO, APP.STATUS.ENTREGUE, APP.STATUS.CANCELADO, APP.STATUS.EXPIRADO], true)
    .setAllowInvalid(false).build());
  const data = rs.getRange(2, 1, rs.getMaxRows() - 1, NCOLS);
  rs.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR($K2="Cancelado",$K2="Expirado")')
      .setFontColor(COLOR.grey).setRanges([data]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(APP.STATUS.ENTREGUE)
      .setBackground(COLOR.green100).setFontColor(COLOR.green800).setBold(true).setRanges([statusCol]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(APP.STATUS.RESERVADO)
      .setBackground(COLOR.yellow50).setFontColor('#5C4A00').setBold(true).setRanges([statusCol]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",MOD(ROW(),2)=1)')
      .setBackground(COLOR.paper).setRanges([data]).build(),
  ]);
  if (rs.getFilter()) rs.getFilter().remove();
  rs.getRange(1, 1, rs.getMaxRows(), NCOLS).createFilter();
  expirarReservas();

  // Configurações e guia: validade da reserva
  cfg.getRange('A22:B22').setValues([['Validade da reserva', 'Quem reservou até 18/10: até terça, 20/10, às 18h. A partir de 19/10: 1 dia, até as 18h do dia seguinte (no máximo 22/10).']]);
  const cfgLabels = cfg.getRange(1, 1, cfg.getLastRow(), 1).getValues().map(r => String(r[0]).trim());
  const hRow = cfgLabels.indexOf('Horário de retirada');
  if (hRow !== -1) cfg.getRange(hRow + 1, 2).setValue(APP.DEFAULTS.horario);
  cfg.getRange('A21:B21').copyFormatToRange(cfg, 1, 2, 22, 22);
  const guia = sheet_(APP.SHEETS.GUIA);
  const guiaTxt = guia.getRange(1, 2, guia.getLastRow(), 1).getValues().map(r => String(r[0]));
  const aviso = 'A entrega começa no domingo, 18/10, às 11h (das 9h às 18h). Quem reservou até 18/10 tem até terça, 20/10, às 18h; quem reservar a partir de 19/10 tem 1 dia (até as 18h do dia seguinte). Reservas não retiradas no prazo viram Expirado sozinhas e as camisas voltam ao estoque. O prazo aparece na coluna Retirar até.';
  const old = guiaTxt.findIndex(t => t.indexOf('Reservas não retiradas') !== -1);
  if (old !== -1) guia.getRange(old + 1, 2).setValue(aviso);
  else if (guiaTxt.indexOf(aviso) === -1) {
    const r = guia.getLastRow() + 2;
    guia.getRange(r, 1, 1, 2).setValues([['!', aviso]]);
    guia.getRange(r - 3, 1, 1, 2).copyFormatToRange(guia, 1, 2, r, r);
  }

  // Avisos antes de editar o que não deve ser mexido (não bloqueia ninguém)
  protectRange_(rs.getRange(1, 1, rs.getMaxRows(), COL.TOTAL), 'Preenchido pelo site — evite editar');
  protectSheet_(sheet_(APP.SHEETS.PAINEL), 'Painel — só fórmulas', []);
  balcoes.forEach(bal => protectSheet_(bal, bal.getName() + ' — edite só os campos amarelos e a caixa Entregue',
    [bal.getRange('B3:C3'), bal.getRange('B4:C4'), bal.getRange('B5')]));

  installTrigger_(ss.getId());
  installHourlyTrigger_();
  ScriptApp.getProjectTriggers()  // sobra da versão "fila rápida"
    .filter(t => t.getHandlerFunction() === 'sincronizar')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// Garante as abas Balcão 1, 2 e 3: a antiga "Balcão" vira "Balcão 1" e as outras são cópias dela.
function balcoes_(ss) {
  const names = APP.SHEETS.BALCOES;
  let first = ss.getSheetByName(names[0]);
  if (!first) {
    first = ss.getSheetByName(APP.SHEETS.BALCAO);
    if (!first) throw new Error('Aba "' + APP.SHEETS.BALCAO + '" não encontrada na planilha.');
    first.setName(names[0]);
  }
  let pos = first.getIndex();
  return names.map((name, i) => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = first.copyTo(ss).setName(name);
      sh.getRange('B3:C4').clearContent();
      sh.getRange('B6').clearContent().setBackground(null);
    }
    if (i) { ss.setActiveSheet(sh); ss.moveActiveSheet(++pos); }
    return sh;
  });
}

// Se o gatilho da versão "fila rápida" ainda existir, não faz nada.
function sincronizar() {}

function painelFormulas_(sh) {
  const R = 'Reservas!';
  const S = R + 'K2:K';
  // Estoque lido direto das células da aba Configurações (B11:B14), sem depender de nome
  const CFG = "'" + APP.SHEETS.CONFIG + "'!";
  const ST = 'SUM(' + CFG + 'B11:B14)';
  // Cartões: valor na linha de baixo do rótulo
  const cards = {
    A5: '=COUNTIFS(' + R + 'A2:A,"<>",' + S + ',"<>Cancelado",' + S + ',"<>Expirado")',
    C5: '=SUMIFS(' + R + 'I2:I,' + S + ',"<>Cancelado",' + S + ',"<>Expirado")',
    C6: '="de "&' + ST + '&" camisas"',
    E5: '=SUMIFS(' + R + 'I2:I,' + S + ',"Entregue")',
    G5: '=C5-E5',
    A9: '=MAX(0,' + ST + '-C5)',
    C9: '=SUMIFS(' + R + 'J2:J,' + S + ',"Reservado")',
    E9: '=SUMIFS(' + R + 'J2:J,' + S + ',"Entregue")',
    G9: '=COUNTIF(' + S + ',"Cancelado")+COUNTIF(' + S + ',"Expirado")',
  };
  Object.keys(cards).forEach(a1 => sh.getRange(a1).setFormula(cards[a1]));
  ['C9', 'E9'].forEach(a1 => sh.getRange(a1).setNumberFormat('"R$" #,##0.00'));
  ['A5', 'C5', 'E5', 'G5', 'A9', 'G9'].forEach(a1 => sh.getRange(a1).setNumberFormat('0'));

  // Tabela por tamanho (linhas 14 a 17) e total (linha 18)
  APP.SIZES.forEach((sz, i) => {
    const r = 14 + i;
    const L = columnLetter_(COL[sz]);
    sh.getRange(r, 1, 1, 8).setFormulas([[
      '="' + sz + '"',
      '=' + CFG + 'B' + (11 + i),
      '=SUMIFS(' + R + L + '2:' + L + ',' + S + ',"<>Cancelado",' + S + ',"<>Expirado")',
      '=SUMIFS(' + R + L + '2:' + L + ',' + S + ',"Entregue")',
      '=C' + r + '-D' + r,
      '=MAX(0,B' + r + '-C' + r + ')',
      '=SPARKLINE(C' + r + ',{"charttype","bar";"max",MAX(1,B' + r + ');"color1","' + COLOR.green600 + '"})',
      '=IFERROR(C' + r + '/B' + r + ',0)',
    ]]);
  });
  const t = 14 + APP.SIZES.length;
  const l = t - 1;
  sh.getRange(t, 1, 1, 8).setFormulas([[
    '="Total"', '=SUM(B14:B' + l + ')', '=SUM(C14:C' + l + ')', '=SUM(D14:D' + l + ')',
    '=SUM(E14:E' + l + ')', '=SUM(F14:F' + l + ')',
    '=SPARKLINE(C' + t + ',{"charttype","bar";"max",MAX(1,B' + t + ');"color1","' + COLOR.green800 + '"})',
    '=IFERROR(C' + t + '/B' + t + ',0)',
  ]]);
  sh.getRange(14, 2, APP.SIZES.length + 1, 5).setNumberFormat('0');
  sh.getRange(14, 8, APP.SIZES.length + 1, 1).setNumberFormat('0%');
  painelHoje_(sh);
}

/** RODE QUANDO QUISER: acrescenta ao Painel a seção Hoje, o Comitê e o status do site. */
function atualizarPainel() {
  const ss = ss_();
  ss.setSpreadsheetLocale('en_US');
  SpreadsheetApp.flush();
  try {
    painelHoje_(sheet_(APP.SHEETS.PAINEL));
  } finally {
    SpreadsheetApp.flush();
    ss.setSpreadsheetLocale('pt_BR');
    SpreadsheetApp.flush();
  }
}

// Linha do Painel onde o sincronizarSupabase escreve o status do site
const PAINEL_STATUS = 'A3';

// Seção "Hoje" (linhas 20 a 26), no mesmo estilo dos cartões do topo
function painelHoje_(sh) {
  const R = 'Reservas!';
  const HOJE = '">="&TODAY()';
  const COMITE = '"' + VENDA.OBS + '"';
  const NAO_COMITE = '"<>' + VENDA.OBS + '"';

  // Aviso antigo da linha 20 desce para a 28
  const aviso = sh.getRange('A20').getValue();
  if (aviso && String(aviso).indexOf('Hoje') !== 0) {
    sh.getRange('A20:H20').copyTo(sh.getRange('A28:H28'));
    sh.getRange('A20:H20').breakApart().clear();
  }

  sh.getRange('A12:H12').copyTo(sh.getRange('A20:H20'), { formatOnly: true });
  sh.getRange('A20').setValue('Hoje');
  sh.getRange('A4:H6').copyTo(sh.getRange('A21:H23'), { formatOnly: true });
  sh.getRange('A8:H10').copyTo(sh.getRange('A24:H26'), { formatOnly: true });
  const cards = [
    ['A21', 'Reservas pelo site', 'A22', '=COUNTIFS(' + R + 'B2:B,' + HOJE + ',' + R + 'N2:N,' + NAO_COMITE + ')', 'A23', 'feitas hoje', '0'],
    ['C21', 'Retiradas no Balcão', 'C22', '=COUNTIFS(' + R + 'K2:K,"Entregue",' + R + 'M2:M,' + HOJE + ',' + R + 'N2:N,' + NAO_COMITE + ')', 'C23', 'reservas entregues hoje', '0'],
    ['E21', 'Vendas no Comitê', 'E22', '=COUNTIFS(' + R + 'N2:N,' + COMITE + ',' + R + 'M2:M,' + HOJE + ')', 'E23', 'sem reserva, hoje', '0'],
    ['G21', 'Recebido hoje', 'G22', '=SUMIFS(' + R + 'J2:J,' + R + 'K2:K,"Entregue",' + R + 'M2:M,' + HOJE + ')', 'G23', 'Balcão + Comitê', '"R$" #,##0.00'],
    ['A24', 'Comitê (total)', 'A25', '=COUNTIF(' + R + 'N2:N,' + COMITE + ')', 'A26', 'camisas vendidas sem reserva', '0'],
    ['C24', 'Comitê (valor)', 'C25', '=SUMIFS(' + R + 'J2:J,' + R + 'N2:N,' + COMITE + ')', 'C26', 'recebido nas vendas', '"R$" #,##0.00'],
    ['E24', 'Pelo site (total)', 'E25', '=COUNTIFS(' + R + 'A2:A,"<>",' + R + 'N2:N,' + NAO_COMITE + ')', 'E26', 'reservas feitas no site', '0'],
    ['G24', 'Vencidas', 'G25', '=COUNTIF(' + R + 'K2:K,"Expirado")', 'G26', 'não retiradas no prazo', '0'],
  ];
  cards.forEach(([l, label, v, f, c, cap, fmt]) => {
    sh.getRange(l).setValue(label);
    sh.getRange(v).setFormula(f).setNumberFormat(fmt);
    sh.getRange(c).setValue(cap);
  });
  // Os cartões do Comitê em azul, para diferenciar do site
  ['E22', 'A25', 'C25'].forEach(a1 => sh.getRange(a1).setFontColor(COLOR.blue));
  sh.getRange('G22').setFontColor(COLOR.green600);

  // Linha de status (escrita pelo sincronizarSupabase a cada minuto)
  sh.getRange('A3:H3').merge().setBackground(COLOR.green900).setFontColor(COLOR.yellow)
    .setFontSize(10).setFontWeight('bold').setHorizontalAlignment('left');
  if (!sh.getRange(PAINEL_STATUS).getValue()) sh.getRange(PAINEL_STATUS).setValue('Aguardando a primeira sincronização com o site…');
}


// Atualiza o intervalo nomeado sem apagar: apagar transforma em #REF! as fórmulas que o usam.
function named_(ss, name, range) {
  const existing = ss.getNamedRanges().find(n => n.getName() === name);
  if (existing) existing.setRange(range);
  else ss.setNamedRange(name, range);
}

function checkbox_(range, value) {
  range.clearDataValidations();
  range.insertCheckboxes();
  range.setValue(value);
}

function protectRange_(range, description) {
  const sh = range.getSheet();
  const exists = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).some(p => p.getDescription() === description);
  if (!exists) range.protect().setDescription(description).setWarningOnly(true);
}

function protectSheet_(sh, description, editable) {
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  const p = sh.protect().setDescription(description).setWarningOnly(true);
  if (editable.length) p.setUnprotectedRanges(editable);
}

/** Mostra o link da planilha que o site está usando e o saldo atual. */
function verPlanilha() {
  Logger.log('%s', ss_().getUrl());
  const s = settings_();
  Logger.log('Preço R$ %s, máximo %s por reserva, reservas abertas: %s', s.price, s.max, s.open ? 'sim' : 'não');
  Logger.log('Saldo: %s', JSON.stringify(remaining_(s.stock)));
}

function installHourlyTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'expirarReservas')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('expirarReservas').timeBased().everyHours(1).create();
}

function installTrigger_(id) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'aoEditar')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('aoEditar').forSpreadsheet(id).onEdit().create();
}

/* ------------------------------------------------------------------ */
/* Teste                                                              */
/* ------------------------------------------------------------------ */

/** Cria uma reserva de teste. Depois mude o Status dela para Cancelado (ou apague a linha). */
function testarReserva() {
  const res = saveReservation_({ name: 'Teste do Sistema', phone: '81999990000', items: { M: 2, GG: 1 }, qty: 3 }, settings_().price);
  Logger.log(JSON.stringify(res));
}

/* ------------------------------------------------------------------ */
/* Utilitários                                                        */
/* ------------------------------------------------------------------ */

let ss__ = null;
function ss_() {
  if (ss__) return ss__;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || APP.SPREADSHEET_ID;
  ss__ = SpreadsheetApp.openById(id);
  return ss__;
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Aba "' + name + '" não encontrada na planilha.');
  return sh;
}

function columnLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Data/hora no horário de Recife, como texto que o Sheets converte em data
function horaRecife_(d) {
  return Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd HH:mm:ss');
}

// Caixa marcada (true) ou "Sim" escrito/selecionado
function isOn_(v) {
  return v === true || isValue_(v, 'Sim') || isValue_(v, 'TRUE');
}

function isValue_(x, wanted) {
  return String(x).normalize('NFC').trim().toLowerCase() === wanted.normalize('NFC').toLowerCase();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Evita injeção de fórmulas na planilha (=, +, -, @).
function safe_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function formatPhone_(p) {
  return '(' + p.slice(0, 2) + ') ' + p.slice(2, 7) + '-' + p.slice(7);
}

/* ------------------------------------------------------------------ */
/* Supabase: o site reserva lá; a planilha recebe a cada 1 minuto     */
/* ------------------------------------------------------------------ */

const SUPA = {
  URL: 'https://mmvcveyfvysrzoxcvzxd.supabase.co/rest/v1/rpc/',
  KEY: 'sb_publishable_UXy2eIUyoG-BW8COyuhSmg_LGBvxc4S',
  TOKEN: '4d7d137b1647a356dd2bea46fc61e7b9a98444c2074fd77d', // senha da planilha no Supabase (não divulgue)
};

function supa_(fn, body) {
  const res = UrlFetchApp.fetch(SUPA.URL + fn, {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPA.KEY },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase ' + fn + ': ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** RODE UMA VEZ: liga a planilha ao Supabase (gatilho de 1 em 1 minuto) e já sincroniza. */
function conectarSupabase() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['sincronizarSupabase', 'sincronizar'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sincronizarSupabase').timeBased().everyMinutes(1).create();
  sincronizarSupabase();
}

/** De 1 em 1 minuto: traz as reservas novas para a aba Reservas e manda o saldo real ao Supabase. */
function sincronizarSupabase() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const novas = supa_('puxar', { p_token: SUPA.TOKEN });
    const rs = sheet_(APP.SHEETS.RESERVAS);
    const last = rs.getLastRow();
    let rows = last >= 2 ? rs.getRange(2, 1, last - 1, NCOLS).getValues() : [];
    const existing = new Set(rows.map(r => r[COL.CODIGO - 1]));

    const add = novas.filter(n => !existing.has(n.codigo)).map(n => [
      n.codigo, n.criado_em, safe_(n.nome), formatPhone_(n.whatsapp),
      ...APP.SIZES.map(sz => (sz === n.tamanho ? 1 : '')),
      1, Number(n.total), n.status || APP.STATUS.RESERVADO, n.atendente || '', n.retirado_em || '', n.obs || '', n.prazo,
    ]);
    if (add.length) {
      const first = rs.getLastRow() + 1;
      if (first > 2) rs.getRange(first - 1, 1, 1, NCOLS).copyFormatToRange(rs, 1, NCOLS, first, first + add.length - 1);
      rs.getRange(first, COL.WHATS, add.length, 1).setNumberFormat('@');
      rs.getRange(first, 1, add.length, NCOLS).setValues(add);
      SpreadsheetApp.flush();
      rows = rows.concat(add);
    }

    // Saldo real = estoque da Configurações − camisas em reservas ativas (entregues ou no prazo)
    const s = settings_();
    const now = new Date();
    const used = {};
    APP.SIZES.forEach(sz => { used[sz] = 0; });
    const whats = new Set();
    rows.forEach(r => {
      if (!isActive_(r, now)) return;
      APP.SIZES.forEach(sz => { used[sz] += Number(r[COL[sz] - 1]) || 0; });
      const w = String(r[COL.WHATS - 1]).replace(/\D/g, '').slice(-11);
      if (w) whats.add(w);
    });
    const saldo = {};
    APP.SIZES.forEach(sz => { saldo[sz] = Math.max(0, (s.stock[sz] || 0) - used[sz]); });

    const res = supa_('ajustar', {
      p_token: SUPA.TOKEN,
      p_gravadas: novas.map(n => n.codigo),
      p_saldo: saldo,
      p_whats: Array.from(whats),
      p_codigos: rows.map(r => r[COL.CODIGO - 1]).filter(Boolean),
      p_aberto: s.open,
      p_preco: s.price,
    });
    Logger.log('Reservas novas na planilha: %s. No site agora: %s (aberto: %s)', add.length, JSON.stringify(res.stock), res.open);
    try {
      const st = res.stock || {};
      sheet_(APP.SHEETS.PAINEL).getRange(PAINEL_STATUS).setValue(
        (res.open ? '● Reservas ABERTAS' : '○ Reservas FECHADAS') + '   ·   sincronizado às ' +
        Utilities.formatDate(new Date(), APP.TZ, 'HH:mm') + '   ·   o site vê: ' +
        APP.SIZES.map(sz => sz + ' ' + (st[sz] || 0)).join('  ') + (add.length ? '   ·   +' + add.length + ' novas' : ''));
    } catch (e) { console.error(e); }
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Venda no Comitê (abas Venda 1 e Venda 2)                           */
/* ------------------------------------------------------------------ */
// Para quem chega sem reserva: o atendente preenche nome, WhatsApp, tamanho e o próprio nome e
// marca "Vender". A venda usa o mesmo estoque do site (Supabase) e entra na aba Reservas já como
// Entregue, com a observação "Venda no Comitê".

/** RODE UMA VEZ: cria (ou refaz) as abas Venda 1 e Venda 2. Não mexe nas vendas já feitas. */
function criarVendas() {
  const ss = ss_();
  // Fórmulas escritas em inglês (vírgula) e a planilha volta para português no fim, como no ativar
  ss.setSpreadsheetLocale('en_US');
  SpreadsheetApp.flush();
  try {
    let pos = (ss.getSheetByName(APP.SHEETS.BALCOES[APP.SHEETS.BALCOES.length - 1]) || ss.getSheets()[0]).getIndex();
    APP.SHEETS.VENDAS.forEach(name => {
      let sh = ss.getSheetByName(name) || ss.insertSheet(name);
      ss.setActiveSheet(sh);
      ss.moveActiveSheet(++pos);
      montarVenda_(sh, name);
    });
  } finally {
    SpreadsheetApp.flush();
    ss.setSpreadsheetLocale('pt_BR');
    SpreadsheetApp.flush();
  }
  Logger.log('Abas %s prontas.', APP.SHEETS.VENDAS.join(' e '));
}

function montarVenda_(sh, name) {
  const old = sh.getRange(VENDA.ATENDENTE).getValue(); // mantém o atendente se a aba já existia
  const atendente = typeof old === 'string' ? old.trim() : '';
  const all = sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns());
  all.breakApart().clearDataValidations().clear();
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());
  if (sh.getMaxColumns() > 8) sh.deleteColumns(9, sh.getMaxColumns() - 8);
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, sh.getMaxRows(), 8).setFontFamily('Arial').setFontSize(11).setVerticalAlignment('middle');
  [150, 190, 150, 110, 150, 120, 20, 20].forEach((w, i) => sh.setColumnWidth(i + 1, w));

  // Cabeçalho (igual ao Balcão)
  sh.getRange('A1:F1').merge().setValue('Venda no Comitê — ' + name)
    .setBackground(COLOR.green800).setFontColor(COLOR.yellow).setFontSize(18).setFontWeight('bold');
  sh.getRange('A2:F2').merge()
    .setValue('Para quem chega SEM reserva. Preencha os campos amarelos, receba R$ 22,00, marque Vender e entregue a camisa. Quem reservou pelo site: use o Balcão.')
    .setBackground(COLOR.green800).setFontColor('#FFFFFF').setFontSize(10).setWrap(true);
  sh.setRowHeight(1, 44);
  sh.setRowHeight(2, 36);
  sh.setRowHeight(3, 10);

  // Campos
  const campos = [
    [4, 'Nome completo', 'B4:D4', 'Nome e sobrenome da pessoa'],
    [5, 'WhatsApp', 'B5:D5', 'Com DDD, ex.: 81 99999-9999'],
    [6, 'Tamanho', 'B6', 'Escolha na lista: P, M, G ou GG'],
    [7, 'Atendente', 'B7:D7', 'Seu nome (fica salvo entre as vendas)'],
    [8, 'Vender', 'B8', 'Marque depois de receber o pagamento'],
  ];
  campos.forEach(([row, label, range, dica]) => {
    sh.setRowHeight(row, 32);
    sh.getRange(row, 1).setValue(label).setFontWeight('bold').setFontColor(COLOR.green900);
    const r = sh.getRange(range);
    if (range.indexOf(':') !== -1) r.merge();
    r.setBackground(COLOR.yellow50).setFontWeight('bold').setFontSize(12)
      .setBorder(true, true, true, true, null, null, COLOR.line, SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(row, 5, 1, 2).merge().setValue(dica).setFontColor(COLOR.muted).setFontSize(9).setWrap(true);
  });
  sh.getRange(VENDA.TAMANHO).setHorizontalAlignment('center')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(APP.SIZES, true).setAllowInvalid(false).build());
  sh.getRange('C6:D6').merge();
  checkbox_(sh.getRange(VENDA.VENDER), false);
  sh.getRange(VENDA.VENDER).setHorizontalAlignment('center');
  if (atendente) sh.getRange(VENDA.ATENDENTE).setValue(atendente);

  // Resultado
  sh.getRange('A9').setValue('Resultado').setFontWeight('bold').setFontColor(COLOR.green900);
  sh.getRange('B9:F9').merge().setWrap(true).setFontWeight('bold').setFontSize(12)
    .setBackground(COLOR.paper).setValue('Pronto para vender.').setFontColor(COLOR.muted);
  sh.setRowHeight(9, 56);

  // Disponíveis agora (mesmo saldo do Painel)
  sh.setRowHeight(10, 14);
  sh.getRange('A11:F11').merge().setValue('Disponíveis agora (site e Comitê usam o mesmo estoque)')
    .setFontWeight('bold').setFontColor(COLOR.green800).setBackground(COLOR.paper);
  sh.getRange('A12:F12').setValues([['Tamanho', 'P', 'M', 'G', 'GG', 'Total']])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground(COLOR.green800).setHorizontalAlignment('center');
  sh.getRange('A13:F13').setFormulas([['="Camisas"', '=Painel!F14', '=Painel!F15', '=Painel!F16', '=Painel!F17', '=SUM(B13:E13)']])
    .setFontWeight('bold').setFontSize(16).setFontColor(COLOR.green800).setHorizontalAlignment('center')
    .setBorder(true, true, true, true, true, null, COLOR.line, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('A13').setFontSize(11).setFontColor(COLOR.muted);
  sh.setRowHeight(13, 40);

  // Vendas no Comitê
  sh.setRowHeight(14, 14);
  const N = "Reservas!N2:N=\"" + VENDA.OBS + "\"";
  sh.getRange('A15:F15').merge().setFormula(
    '="Vendas no Comitê hoje: "&COUNTIFS(Reservas!N2:N,"' + VENDA.OBS + '",Reservas!M2:M,">="&TODAY())&' +
    '" camisas, R$ "&TEXT(SUMIFS(Reservas!J2:J,Reservas!N2:N,"' + VENDA.OBS + '",Reservas!M2:M,">="&TODAY()),"0.00")&' +
    '" recebidos   ·   Total: "&COUNTIF(Reservas!N2:N,"' + VENDA.OBS + '")&" camisas"')
    .setFontWeight('bold').setFontColor(COLOR.green800).setBackground(COLOR.paper);
  sh.getRange('A16:F16').setValues([['Código', 'Nome', 'WhatsApp', 'Tamanho', 'Atendente', 'Horário']])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground(COLOR.green800);
  sh.getRange('A17').setFormula(
    '=ARRAYFORMULA(IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({Reservas!A2:A,Reservas!C2:C,Reservas!D2:D,' +
    'IF(Reservas!E2:E<>"","P",IF(Reservas!F2:F<>"","M",IF(Reservas!G2:G<>"","G","GG"))),Reservas!L2:L,Reservas!M2:M},' +
    N + '),6,FALSE),30,6),"Nenhuma venda no Comitê ainda."))');
  sh.getRange('A17:F46').setFontSize(10).setBorder(null, null, true, null, null, true, COLOR.line, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange('A17:A46').setFontWeight('bold');
  sh.getRange('D17:D46').setHorizontalAlignment('center');
  sh.getRange('F17:F46').setNumberFormat('dd/MM HH:mm');

  protectSheet_(sh, name + ' — edite só os campos amarelos e a caixa Vender',
    [sh.getRange('B4:D4'), sh.getRange('B5:D5'), sh.getRange('B6'), sh.getRange('B7:D7'), sh.getRange('B8')]);
  sh.setActiveSelection(VENDA.NOME);
}

// Onde ficam os campos nas abas de venda
const VENDA = { NOME: 'B4', WHATS: 'B5', TAMANHO: 'B6', ATENDENTE: 'B7', VENDER: 'B8', RESULTADO: 'B9', OBS: 'Venda no Comitê' };

function onVendaEdit_(e) {
  const sh = e.range.getSheet();
  if (e.range.getA1Notation() !== VENDA.VENDER || !isOn_(e.range.getValue())) return;
  const say = (msg, ok) => sh.getRange(VENDA.RESULTADO).setValue(msg)
    .setBackground(ok ? COLOR.green100 : COLOR.blue50)
    .setFontColor(ok ? COLOR.green800 : COLOR.blue);
  try {
    const val = a => String(sh.getRange(a).getValue() || '').trim();
    const nome = val(VENDA.NOME), whats = val(VENDA.WHATS), tam = val(VENDA.TAMANHO), atendente = val(VENDA.ATENDENTE);
    if (!nome || !whats || !tam || !atendente) {
      return say('Preencha nome completo, WhatsApp, tamanho e atendente antes de marcar Vender.', false);
    }
    say('Vendendo…', true);
    const r = supa_('vender', { p_token: SUPA.TOKEN, p_nome: nome, p_whatsapp: whats, p_tamanho: tam, p_atendente: atendente });
    if (!r.ok) return say(r.error, false);
    [VENDA.NOME, VENDA.WHATS, VENDA.TAMANHO].forEach(a => sh.getRange(a).clearContent());
    say('✓ Vendida: ' + r.code + ' — ' + r.name + ', tamanho ' + r.size + '. Receba R$ ' +
      Number(r.total).toFixed(2).replace('.', ',') + ' e entregue a camisa.', true);
    sincronizarSupabase(); // já entra na aba Reservas e na lista abaixo
  } catch (err) {
    console.error(err);
    say('Não deu para registrar a venda agora (sem conexão com o sistema). Tente de novo em alguns segundos.', false);
  } finally {
    sh.getRange(VENDA.VENDER).setValue(false);
  }
}
