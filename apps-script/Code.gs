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
 *
 * INSTALAÇÃO (uma vez): cole este código, rode `ativar` e depois publique uma nova versão
 * em Implantar → Gerenciar implantações (a URL do site não muda).
 */

const APP = {
  // Planilha "Bloco do 22 — Reservas de camisas" (ID que aparece na URL dela)
  SPREADSHEET_ID: '1mjnLKelq4nEKKi9UhNNnodgJvK9-_zIo6tKXsoFxssM',
  SIZES: ['P', 'M', 'G', 'GG'],
  SHEETS: { PAINEL: 'Painel', BALCAO: 'Balcão', RESERVAS: 'Reservas', CONFIG: 'Configurações', GUIA: 'Como usar' },
  STATUS: { RESERVADO: 'Reservado', ENTREGUE: 'Entregue', CANCELADO: 'Cancelado' },
  TZ: 'America/Recife',
  // Valores iniciais da aba Configurações (depois a equipe edita lá mesmo)
  DEFAULTS: {
    price: 22,
    max: 3,
    stock: { P: 150, M: 250, G: 400, GG: 200 },
    local: 'Comitê da Direita Pernambucana',
    endereco: 'Av. Herculano Bandeira, 766 — Pina, Recife/PE',
    horario: 'Segunda a sábado, das 9h às 18h',
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
const COL = { CODIGO: 1, DATA: 2, NOME: 3, WHATS: 4, P: 5, M: 6, G: 7, GG: 8, QTD: 9, TOTAL: 10, STATUS: 11, ATENDENTE: 12, RETIRADA: 13, OBS: 14 };
const HEADERS = ['Código', 'Reservado em', 'Nome completo', 'WhatsApp', 'P', 'M', 'G', 'GG', 'Qtd.', 'Total', 'Status', 'Atendente', 'Retirado em', 'Observações'];
const NCOLS = HEADERS.length;

/* ------------------------------------------------------------------ */
/* Endpoints do site                                                  */
/* ------------------------------------------------------------------ */

function doGet() {
  const s = settings_();
  return json_({ ok: true, open: s.open, price: s.price, max: s.max, stock: remaining_(s.stock) });
}

function doPost(e) {
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

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
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

  const row = sh.getLastRow() + 1;
  sh.getRange(row, COL.WHATS).setNumberFormat('@');
  sh.getRange(row, COL.DATA).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(row, COL.RETIRADA).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(row, COL.TOTAL).setNumberFormat('"R$" #,##0.00');
  sh.getRange(row, COL.P, 1, 5).setHorizontalAlignment('center');
  sh.getRange(row, COL.CODIGO).setFontWeight('bold');
  sh.getRange(row, 1, 1, NCOLS).setValues([[
    code, horaRecife_(now), safe_(v.name), formatPhone_(v.phone),
    ...APP.SIZES.map(sz => v.items[sz] || ''),
    v.qty, total, APP.STATUS.RESERVADO, '', '', '',
  ]]);
  SpreadsheetApp.flush();

  return {
    code: code,
    name: v.name,
    items: APP.SIZES.filter(sz => v.items[sz]).map(sz => ({ size: sz, qty: v.items[sz] })),
    qty: v.qty,
    total: total,
    createdAt: now.toISOString(),
  };
}

// Saldo por tamanho = estoque − camisas em reservas que não foram canceladas.
function remaining_(stock) {
  const sh = sheet_(APP.SHEETS.RESERVAS);
  const last = sh.getLastRow();
  const used = {};
  APP.SIZES.forEach(sz => { used[sz] = 0; });
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, COL.STATUS).getValues().forEach(r => {
      if (!r[COL.CODIGO - 1] || isValue_(r[COL.STATUS - 1], APP.STATUS.CANCELADO)) return;
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
    open: open ? isOn_(open.getValue()) : true,
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
  if (qty > maxPerOrder) return { error: 'O limite é de ' + maxPerOrder + ' camisas por reserva.' };

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
  if (name === APP.SHEETS.BALCAO) return onBalcaoEdit_(e);
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
    const pending = found.filter(f => !isValue_(f.data[COL.STATUS - 1], APP.STATUS.ENTREGUE));
    if (!pending.length) {
      const f = found[found.length - 1].data;
      return say('Essa reserva já foi entregue' + (f[COL.ATENDENTE - 1] ? ' por ' + f[COL.ATENDENTE - 1] : '') + '. Não entregue de novo.', false);
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
  ss.setSpreadsheetLocale('pt_BR');

  // Configurações: intervalos nomeados, caixa "Reservas abertas" e total do estoque
  const cfg = sheet_(APP.SHEETS.CONFIG);
  named_(ss, 'CFG_PRECO', cfg.getRange('B5'));
  named_(ss, 'CFG_MAX', cfg.getRange('B6'));
  named_(ss, 'CFG_ABERTAS', cfg.getRange('B7'));
  named_(ss, 'CFG_ESTOQUE', cfg.getRange('A11:B14'));
  checkbox_(cfg.getRange('B7'), isOn_(cfg.getRange('B7').getValue()));
  cfg.getRange('B15').setFormula('=SUM(B11:B14)');

  // Balcão: caixa "Entregue" e busca
  const bal = sheet_(APP.SHEETS.BALCAO);
  checkbox_(bal.getRange('B5'), false);
  bal.getRange('A9').setFormula(
    '=ARRAYFORMULA(IF($B$3="","",IFERROR(FILTER(Reservas!A2:N,' +
      '(Reservas!A2:A=UPPER(TRIM($B$3)))+' +
      'IF(LEN(REGEXREPLACE($B$3&"","\\D",""))>=8,RIGHT(REGEXREPLACE(Reservas!D2:D&"","\\D",""),LEN(REGEXREPLACE($B$3&"","\\D","")))=REGEXREPLACE($B$3&"","\\D",""),FALSE)' +
      '),"Nenhuma reserva encontrada para esse código ou WhatsApp.")))');

  // Painel: todas as fórmulas
  painelFormulas_(sheet_(APP.SHEETS.PAINEL));

  // Reservas: filtro
  const rs = sheet_(APP.SHEETS.RESERVAS);
  if (!rs.getFilter()) rs.getRange(1, 1, rs.getMaxRows(), NCOLS).createFilter();

  // Avisos antes de editar o que não deve ser mexido (não bloqueia ninguém)
  protectRange_(rs.getRange(1, 1, rs.getMaxRows(), COL.TOTAL), 'Preenchido pelo site — evite editar');
  protectSheet_(sheet_(APP.SHEETS.PAINEL), 'Painel — só fórmulas', []);
  protectSheet_(bal, 'Balcão — edite só os campos amarelos e a caixa Entregue',
    [bal.getRange('B3:C3'), bal.getRange('B4:C4'), bal.getRange('B5')]);

  installTrigger_(ss.getId());
  SpreadsheetApp.flush();

  const s = settings_();
  Logger.log('Planilha ativada ✅  %s', ss.getUrl());
  Logger.log('Preço R$ %s, máximo %s por reserva, reservas abertas: %s', s.price, s.max, s.open ? 'sim' : 'não');
  Logger.log('Saldo: %s', JSON.stringify(remaining_(s.stock)));
  Logger.log('Agora publique uma nova versão em Implantar → Gerenciar implantações.');
}

function painelFormulas_(sh) {
  const R = 'Reservas!';
  const S = R + 'K2:K';
  const ST = 'SUM(INDEX(CFG_ESTOQUE,0,2))';
  // Cartões: valor na linha de baixo do rótulo
  const cards = {
    A5: '=COUNTIFS(' + R + 'A2:A,"<>",' + S + ',"<>Cancelado")',
    C5: '=SUMIFS(' + R + 'I2:I,' + S + ',"<>Cancelado")',
    C6: '="de "&' + ST + '&" camisas"',
    E5: '=SUMIFS(' + R + 'I2:I,' + S + ',"Entregue")',
    G5: '=C5-E5',
    A9: '=MAX(0,' + ST + '-C5)',
    C9: '=SUMIFS(' + R + 'J2:J,' + S + ',"Reservado")',
    E9: '=SUMIFS(' + R + 'J2:J,' + S + ',"Entregue")',
    G9: '=COUNTIF(' + S + ',"Cancelado")',
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
      '=INDEX(CFG_ESTOQUE,' + (i + 1) + ',2)',
      '=SUMIFS(' + R + L + '2:' + L + ',' + S + ',"<>Cancelado")',
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
}

function named_(ss, name, range) {
  try { ss.removeNamedRange(name); } catch (e) { /* ainda não existia */ }
  ss.setNamedRange(name, range);
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
