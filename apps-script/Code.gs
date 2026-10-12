/**
 * BLOCO DO 22 — Sistema de reservas (Google Apps Script)
 *
 * Planilha (criada por `criarPlanilhaNova`):
 *   • Painel         — números do dia e estoque por tamanho (só fórmulas)
 *   • Balcão         — busca por código ou WhatsApp e caixa "Entregue" para o atendente
 *   • Reservas       — 1 linha por pedido; colunas P, M, G, GG; Status Reservado/Entregue/Cancelado
 *   • Configurações  — preço, máximo por reserva, reservas abertas e estoque por tamanho
 *   • Como usar      — guia da equipe
 *
 * O site envia a reserva → o script valida, confere o estoque e grava em Reservas.
 * Cancelar uma reserva (Status = Cancelado) devolve as camisas ao estoque.
 *
 * INSTALAÇÃO (uma vez): cole este código, rode `criarPlanilhaNova` e depois publique
 * uma nova versão em Implantar → Gerenciar implantações (a URL do site não muda).
 */

const APP = {
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
const WIDTHS = [100, 130, 220, 135, 44, 44, 44, 44, 52, 90, 110, 130, 130, 260];

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
    open: open ? open.getValue() === true : true,
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
/* Automação na planilha (gatilho instalado por criarPlanilhaNova)    */
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
  if (e.range.getA1Notation() !== 'B5' || e.range.getValue() !== true) return;

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
    sh.getRange('B5').setValue(false);
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Criação da planilha                                                */
/* ------------------------------------------------------------------ */

/**
 * RODE UMA VEZ pelo editor. Cria a planilha nova, completa e formatada, liga o site a ela
 * e instala a automação. A planilha antiga não é apagada (fica como histórico).
 */
function criarPlanilhaNova() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty('SPREADSHEET_ID');
  if (existing) {
    try {
      Logger.log('A planilha já existe: %s', SpreadsheetApp.openById(existing).getUrl());
      Logger.log('Para criar outra do zero, rode desligarPlanilha() e depois criarPlanilhaNova() de novo.');
      return;
    } catch (e) { /* arquivo apagado: cria outro */ }
  }

  const ss = SpreadsheetApp.create('Bloco do 22 — Reservas de camisas');
  ss.setSpreadsheetLocale('pt_BR');
  ss.setSpreadsheetTimeZone(APP.TZ);

  const painel = ss.getSheets()[0].setName(APP.SHEETS.PAINEL);
  const balcao = ss.insertSheet(APP.SHEETS.BALCAO, 1);
  const reservas = ss.insertSheet(APP.SHEETS.RESERVAS, 2);
  const config = ss.insertSheet(APP.SHEETS.CONFIG, 3);
  const guia = ss.insertSheet(APP.SHEETS.GUIA, 4);

  buildConfig_(ss, config);     // primeiro: cria os intervalos nomeados usados pelas fórmulas
  buildReservas_(reservas);
  buildPainel_(painel);
  buildBalcao_(balcao);
  buildGuia_(guia);
  ss.setActiveSheet(painel);

  props.setProperty('SPREADSHEET_ID', ss.getId());
  installTrigger_(ss.getId());

  Logger.log('Planilha criada ✅  %s', ss.getUrl());
  Logger.log('Agora publique uma nova versão em Implantar → Gerenciar implantações.');
}

/** Desliga o site da planilha atual (não apaga nada). Use só se for criar outra do zero. */
function desligarPlanilha() {
  PropertiesService.getScriptProperties().deleteProperty('SPREADSHEET_ID');
  Logger.log('Planilha desligada. Rode criarPlanilhaNova() para criar outra.');
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

/* --- estilos comuns --- */

function trim_(sh, rows, cols) {
  if (sh.getMaxColumns() > cols) sh.deleteColumns(cols + 1, sh.getMaxColumns() - cols);
  if (sh.getMaxRows() > rows) sh.deleteRows(rows + 1, sh.getMaxRows() - rows);
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
}

// Mescla e escreve só na primeira célula (o jeito seguro com células mescladas)
function merged_(range, value) {
  range.merge();
  const cell = range.getCell(1, 1);
  if (typeof value === 'string' && value.charAt(0) === '=') cell.setFormula(value);
  else if (value !== undefined) cell.setValue(value);
  return range;
}

function titleBand_(sh, cols, title, subtitle) {
  merged_(sh.getRange(1, 1, 1, cols), title)
    .setBackground(COLOR.green800).setFontColor(COLOR.yellow).setFontFamily('Montserrat')
    .setFontSize(18).setFontWeight('bold').setVerticalAlignment('middle');
  merged_(sh.getRange(2, 1, 1, cols), subtitle)
    .setBackground(COLOR.green800).setFontColor('#FFFFFF').setFontSize(10).setVerticalAlignment('top');
  sh.setRowHeight(1, 52).setRowHeight(2, 28);
}

function sectionTitle_(range, text) {
  merged_(range, text).setFontFamily('Montserrat').setFontSize(12).setFontWeight('bold')
    .setFontColor(COLOR.green800).setVerticalAlignment('bottom');
}

function headerRow_(range) {
  range.setBackground(COLOR.green800).setFontColor('#FFFFFF').setFontWeight('bold')
    .setVerticalAlignment('middle').setHorizontalAlignment('center').setWrap(true);
}

function box_(range) {
  return range.setBorder(true, true, true, true, false, false, COLOR.line, SpreadsheetApp.BorderStyle.SOLID);
}

/* --- Configurações --- */

function buildConfig_(ss, sh) {
  trim_(sh, 30, 3);
  sh.setTabColor(COLOR.blue).setHiddenGridlines(true);
  sh.setColumnWidth(1, 260).setColumnWidth(2, 320).setColumnWidth(3, 380);
  sh.getRange('A1:C30').setBackground(COLOR.paper).setFontFamily('Roboto').setFontSize(11).setVerticalAlignment('middle');
  titleBand_(sh, 3, 'Configurações', 'Mude os valores nos campos amarelos. O site usa os valores novos na próxima reserva.');

  sectionTitle_(sh.getRange('A4:C4'), 'Reservas');
  sh.getRange('A5:C7').setValues([
    ['Preço por camisa', APP.DEFAULTS.price, 'Se mudar o preço, avise quem cuida do site para atualizar o texto.'],
    ['Máximo de camisas por reserva', APP.DEFAULTS.max, ''],
    ['Reservas abertas no site', '', 'Desmarque para encerrar as reservas. O site trava na hora.'],
  ]);
  sh.getRange('B5').setNumberFormat('"R$" #,##0.00').setHorizontalAlignment('left');
  sh.getRange('B6').setNumberFormat('0').setHorizontalAlignment('left');
  sh.getRange('B7').insertCheckboxes().setValue(true);
  ss.setNamedRange('CFG_PRECO', sh.getRange('B5'));
  ss.setNamedRange('CFG_MAX', sh.getRange('B6'));
  ss.setNamedRange('CFG_ABERTAS', sh.getRange('B7'));

  sectionTitle_(sh.getRange('A9:C9'), 'Estoque por tamanho');
  headerRow_(sh.getRange('A10:B10').setValues([['Tamanho', 'Camisas']]));
  const n = APP.SIZES.length;
  const st = sh.getRange(11, 1, n, 2).setValues(APP.SIZES.map(sz => [sz, APP.DEFAULTS.stock[sz]]));
  st.setHorizontalAlignment('center');
  sh.getRange(11, 1, n, 1).setFontWeight('bold').setBackground('#FFFFFF');
  sh.getRange(11, 2, n, 1).setNumberFormat('0');
  ss.setNamedRange('CFG_ESTOQUE', st);
  const totalRow = 11 + n;
  sh.getRange(totalRow, 1, 1, 2).setValues([['Total', '=SUM(B11:B' + (totalRow - 1) + ')']])
    .setFontWeight('bold').setHorizontalAlignment('center').setBackground(COLOR.green100);
  sh.getRange('C11').setValue('Para mudar o estoque, edite estes números. O saldo do site se ajusta sozinho.');

  const info = totalRow + 2;
  sectionTitle_(sh.getRange(info, 1, 1, 3), 'Informações para consulta');
  sh.getRange(info + 1, 1, 4, 2).setValues([
    ['Local de retirada', APP.DEFAULTS.local],
    ['Endereço', APP.DEFAULTS.endereco],
    ['Horário de retirada', APP.DEFAULTS.horario],
    ['Evento', APP.DEFAULTS.evento],
  ]);
  sh.getRange(info + 1, 1, 4, 2).setBackground('#FFFFFF');

  // Campos editáveis em amarelo
  [sh.getRange('B5:B7'), sh.getRange(11, 2, n, 1)].forEach(r =>
    r.setBackground(COLOR.yellow50).setFontWeight('bold')
      .setBorder(true, true, true, true, true, true, COLOR.line, SpreadsheetApp.BorderStyle.SOLID));
  sh.getRange('A5:A7').setFontWeight('bold');
  sh.getRange(info + 1, 1, 4, 1).setFontWeight('bold');
  [sh.getRange('C5:C7'), sh.getRange('C11')].forEach(r =>
    r.setFontColor(COLOR.muted).setFontStyle('italic').setWrap(true).setFontSize(10));
  sh.setRowHeights(4, info + 1, 30);
  sh.setRowHeights(4, 1, 34); sh.setRowHeight(9, 34); sh.setRowHeight(info, 34);
}

/* --- Reservas --- */

function buildReservas_(sh) {
  trim_(sh, 2000, NCOLS);
  sh.setTabColor(COLOR.green600);
  const rows = sh.getMaxRows();
  const all = sh.getRange(1, 1, rows, NCOLS);
  all.setFontFamily('Roboto').setFontSize(10).setVerticalAlignment('middle');

  sh.getRange(1, 1, 1, NCOLS).setValues([HEADERS]);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.setRowHeight(1, 36);
  WIDTHS.forEach((w, i) => sh.setColumnWidth(i + 1, w));

  const body = c => sh.getRange(2, c, rows - 1, 1);
  body(COL.CODIGO).setFontWeight('bold').setFontFamily('Roboto Mono');
  body(COL.DATA).setNumberFormat('dd/MM/yyyy HH:mm');
  body(COL.RETIRADA).setNumberFormat('dd/MM/yyyy HH:mm');
  body(COL.WHATS).setNumberFormat('@');
  body(COL.TOTAL).setNumberFormat('"R$" #,##0.00');
  sh.getRange(2, COL.P, rows - 1, 5).setHorizontalAlignment('center').setNumberFormat('0');
  body(COL.STATUS).setHorizontalAlignment('center').setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList([APP.STATUS.RESERVADO, APP.STATUS.ENTREGUE, APP.STATUS.CANCELADO], true)
      .setAllowInvalid(false).build());
  body(COL.OBS).setWrap(true);

  all.applyRowBanding(SpreadsheetApp.BandingTheme.GREEN, true, false)
    .setHeaderRowColor(COLOR.green800).setFirstRowColor('#FFFFFF').setSecondRowColor(COLOR.paper);
  headerRow_(sh.getRange(1, 1, 1, NCOLS));
  sh.getRange(1, COL.P, 1, 4).setBackground(COLOR.green600);

  const data = sh.getRange(2, 1, rows - 1, NCOLS);
  const statusCol = body(COL.STATUS);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$K2="' + APP.STATUS.CANCELADO + '"')
      .setFontColor(COLOR.grey).setStrikethrough(true).setRanges([data]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(APP.STATUS.ENTREGUE)
      .setBackground(COLOR.green100).setFontColor(COLOR.green800).setBold(true).setRanges([statusCol]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(APP.STATUS.RESERVADO)
      .setBackground(COLOR.yellow50).setFontColor('#5C4A00').setBold(true).setRanges([statusCol]).build(),
  ]);

  all.createFilter();

  // Colunas preenchidas pelo site: aviso antes de editar (não bloqueia)
  sh.getRange(1, 1, rows, COL.TOTAL).protect()
    .setDescription('Preenchido pelo site — evite editar').setWarningOnly(true);
}

/* --- Painel --- */

function buildPainel_(sh) {
  trim_(sh, 40, 8);
  sh.setTabColor(COLOR.yellow).setHiddenGridlines(true);
  sh.setColumnWidths(1, 8, 128);
  sh.getRange('A1:H40').setBackground(COLOR.paper).setFontFamily('Roboto').setVerticalAlignment('middle');
  titleBand_(sh, 8, 'Bloco do 22 — Painel de reservas',
    'Atualiza sozinho a cada reserva. Evento: ' + APP.DEFAULTS.evento + '.');

  const R = 'Reservas!';
  const S = R + 'K2:K';
  const stockTotal = 'SUM(INDEX(CFG_ESTOQUE,0,2))';
  const cards = [
    // [linha, coluna, rótulo, fórmula, formato, nota]
    [4, 1, 'Reservas ativas', '=COUNTIFS(' + R + 'A2:A,"<>",' + S + ',"<>Cancelado")', '0', 'pedidos não cancelados'],
    [4, 3, 'Camisas reservadas', '=SUMIFS(' + R + 'I2:I,' + S + ',"<>Cancelado")', '0', '="de "&' + stockTotal + '&" camisas"'],
    [4, 5, 'Entregues', '=SUMIFS(' + R + 'I2:I,' + S + ',"Entregue")', '0', 'camisas já retiradas'],
    [4, 7, 'A entregar', '=C5-E5', '0', 'reservadas e ainda não retiradas'],
    [8, 1, 'Disponíveis no site', '=MAX(0,' + stockTotal + '-C5)', '0', 'camisas que ainda dá para reservar'],
    [8, 3, 'Valor a receber', '=SUMIFS(' + R + 'J2:J,' + S + ',"Reservado")', '"R$" #,##0.00', 'das reservas pendentes'],
    [8, 5, 'Valor recebido', '=SUMIFS(' + R + 'J2:J,' + S + ',"Entregue")', '"R$" #,##0.00', 'das camisas entregues'],
    [8, 7, 'Canceladas', '=COUNTIF(' + S + ',"Cancelado")', '0', 'reservas canceladas'],
  ];
  cards.forEach(([row, col, label, formula, fmt, note]) => {
    box_(sh.getRange(row, col, 3, 2).setBackground('#FFFFFF'));
    merged_(sh.getRange(row, col, 1, 2), label).setFontSize(10).setFontColor(COLOR.muted).setFontWeight('bold');
    merged_(sh.getRange(row + 1, col, 1, 2), formula).setNumberFormat(fmt)
      .setFontFamily('Montserrat').setFontSize(24).setFontWeight('bold').setFontColor(COLOR.green800).setHorizontalAlignment('left');
    merged_(sh.getRange(row + 2, col, 1, 2), note).setFontSize(9).setFontColor(COLOR.muted);
  });
  sh.setRowHeight(3, 16);
  [4, 8].forEach(r => { sh.setRowHeight(r, 26); sh.setRowHeight(r + 1, 46); sh.setRowHeight(r + 2, 22); });
  sh.setRowHeight(7, 14);
  sh.getRange('G5').setFontColor(COLOR.blue);   // A entregar
  sh.getRange('A9').setFontColor(COLOR.green600); // Disponíveis

  // Tabela por tamanho
  sectionTitle_(sh.getRange('A12:H12'), 'Estoque por tamanho');
  sh.setRowHeight(11, 14).setRowHeight(12, 34);
  headerRow_(sh.getRange(13, 1, 1, 8).setValues([['Tamanho', 'Estoque', 'Reservadas', 'Entregues', 'A entregar', 'Disponíveis', 'Ocupação', '%']]));
  sh.setRowHeight(13, 30);
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
  const lastSize = 13 + APP.SIZES.length;
  const tot = lastSize + 1;
  sh.getRange(tot, 1, 1, 8).setFormulas([[
    '="Total"', '=SUM(B14:B' + lastSize + ')', '=SUM(C14:C' + lastSize + ')', '=SUM(D14:D' + lastSize + ')',
    '=SUM(E14:E' + lastSize + ')', '=SUM(F14:F' + lastSize + ')',
    '=SPARKLINE(C' + tot + ',{"charttype","bar";"max",MAX(1,B' + tot + ');"color1","' + COLOR.green800 + '"})',
    '=IFERROR(C' + tot + '/B' + tot + ',0)',
  ]]);
  const rowsN = APP.SIZES.length + 1;
  sh.getRange(14, 1, rowsN, 8).setBackground('#FFFFFF').setHorizontalAlignment('center').setFontSize(11)
    .setBorder(true, true, true, true, false, true, COLOR.line, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(14, 1, rowsN, 1).setFontWeight('bold').setFontFamily('Montserrat');
  sh.getRange(14, 2, rowsN, 5).setNumberFormat('0');
  sh.getRange(14, 6, rowsN, 1).setFontWeight('bold').setFontColor(COLOR.green800);
  sh.getRange(14, 8, rowsN, 1).setNumberFormat('0%');
  sh.getRange(tot, 1, 1, 8).setBackground(COLOR.green100).setFontWeight('bold');
  sh.setRowHeights(14, rowsN, 30);

  // Destaque em azul quando restarem 20 ou menos camisas de um tamanho
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($B14>0,$F14<=20)')
      .setBackground(COLOR.blue50).setFontColor(COLOR.blue).setRanges([sh.getRange(14, 6, APP.SIZES.length, 1)]).build(),
  ]);

  merged_(sh.getRange(tot + 2, 1, 1, 8),
    'Para dar baixa numa retirada, use a aba Balcão. Para cancelar uma reserva, mude o Status na aba Reservas.')
    .setFontColor(COLOR.muted).setFontSize(10);

  sh.protect().setDescription('Painel — só fórmulas').setWarningOnly(true);
}

/* --- Balcão --- */

function buildBalcao_(sh) {
  trim_(sh, 60, NCOLS);
  sh.setTabColor(COLOR.green800).setHiddenGridlines(true);
  sh.getRange(1, 1, 60, NCOLS).setFontFamily('Roboto').setFontSize(10).setVerticalAlignment('middle');
  WIDTHS.forEach((w, i) => sh.setColumnWidth(i + 1, i === 0 ? 160 : w));
  titleBand_(sh, NCOLS, 'Balcão de retirada',
    'Digite o código ou o WhatsApp, confira a reserva, receba o pagamento e marque Entregue.');

  sh.getRange('A3:A5').setValues([['Código ou WhatsApp'], ['Atendente'], ['Entregue']])
    .setFontWeight('bold').setFontSize(11).setHorizontalAlignment('right');
  sh.getRange('B3:C3').merge().setFontSize(14).setFontWeight('bold').setFontFamily('Roboto Mono');
  sh.getRange('B4:C4').merge().setFontSize(11);
  [sh.getRange('B3:C3'), sh.getRange('B4:C4')].forEach(r =>
    r.setBackground(COLOR.yellow50).setBorder(true, true, true, true, false, false, COLOR.green600, SpreadsheetApp.BorderStyle.SOLID_MEDIUM));
  sh.getRange('B5').insertCheckboxes().setValue(false);
  sh.getRange('D3').setValue('Digite e aperte Enter').setFontColor(COLOR.muted).setFontStyle('italic');
  sh.getRange('D5').setValue('Marque depois de receber o pagamento e entregar todas as camisas')
    .setFontColor(COLOR.muted).setFontStyle('italic');
  sh.getRange(6, 2, 1, NCOLS - 1).merge().setFontWeight('bold').setFontSize(11).setWrap(true);
  sh.setRowHeights(3, 3, 34);
  sh.setRowHeight(6, 34);

  headerRow_(sh.getRange(8, 1, 1, NCOLS).setValues([HEADERS]));
  sh.setRowHeight(8, 32);
  sh.getRange('A9').setFormula(
    '=ARRAYFORMULA(IF($B$3="","",IFERROR(FILTER(Reservas!A2:N,' +
      '(Reservas!A2:A=UPPER(TRIM($B$3)))+' +
      'IF(LEN(REGEXREPLACE($B$3&"","\\D",""))>=8,RIGHT(REGEXREPLACE(Reservas!D2:D&"","\\D",""),LEN(REGEXREPLACE($B$3&"","\\D","")))=REGEXREPLACE($B$3&"","\\D",""),FALSE)' +
      '),"Nenhuma reserva encontrada para esse código ou WhatsApp.")))');
  box_(sh.getRange(9, 1, 20, NCOLS).setBackground('#FFFFFF'));
  sh.getRange(9, 1, 20, 1).setFontWeight('bold').setFontFamily('Roboto Mono');
  sh.getRange(9, COL.DATA, 20, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(9, COL.RETIRADA, 20, 1).setNumberFormat('dd/MM/yyyy HH:mm');
  sh.getRange(9, COL.TOTAL, 20, 1).setNumberFormat('"R$" #,##0.00');
  sh.getRange(9, COL.P, 20, 5).setHorizontalAlignment('center');
  const st = sh.getRange(9, COL.STATUS, 20, 1).setHorizontalAlignment('center').setFontWeight('bold');
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(APP.STATUS.ENTREGUE)
      .setBackground(COLOR.green100).setFontColor(COLOR.green800).setRanges([st]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(APP.STATUS.RESERVADO)
      .setBackground(COLOR.yellow50).setFontColor('#5C4A00').setRanges([st]).build(),
  ]);

  sh.protect().setDescription('Balcão — edite só os campos amarelos e a caixa Entregue').setWarningOnly(true)
    .setUnprotectedRanges([sh.getRange('B3:C3'), sh.getRange('B4:C4'), sh.getRange('B5')]);
}

/* --- Como usar --- */

function buildGuia_(sh) {
  trim_(sh, 40, 2);
  sh.setTabColor(COLOR.muted).setHiddenGridlines(true);
  sh.setColumnWidth(1, 56).setColumnWidth(2, 760);
  sh.getRange('A1:B40').setBackground(COLOR.paper).setFontFamily('Roboto').setFontSize(11)
    .setVerticalAlignment('middle').setWrap(true);
  titleBand_(sh, 2, 'Como usar', 'Guia rápido para a equipe do comitê.');

  const blocks = [
    ['Na retirada (aba Balcão)', [
      'Peça o código da reserva (começa com B22-) ou o WhatsApp da pessoa e digite no campo amarelo.',
      'Confira nome, tamanhos e total. Se o Status for Entregue, a camisa já foi retirada: não entregue de novo.',
      'Receba o pagamento e entregue TODAS as camisas do pedido.',
      'Escreva seu nome em Atendente e marque a caixa Entregue. A planilha registra a data e a hora.',
    ]],
    ['Se alguém desistir', [
      'Na aba Reservas, mude o Status da reserva para Cancelado. As camisas voltam para o estoque do site.',
    ]],
    ['Estoque, preço e encerramento (aba Configurações)', [
      'Para mudar o estoque de um tamanho, edite o número na tabela Estoque por tamanho.',
      'Para encerrar as reservas, desmarque Reservas abertas no site. Para reabrir, marque de novo.',
    ]],
    ['Acompanhamento (aba Painel)', [
      'Mostra reservas, camisas entregues, valores e quanto resta de cada tamanho. Tudo se atualiza sozinho.',
    ]],
  ];
  let r = 4;
  blocks.forEach(([title, steps]) => {
    sectionTitle_(sh.getRange(r, 1, 1, 2), title);
    sh.setRowHeight(r, 34);
    r++;
    steps.forEach((t, i) => {
      sh.getRange(r, 1).setValue(i + 1).setHorizontalAlignment('center').setFontWeight('bold')
        .setBackground(COLOR.yellow).setFontColor(COLOR.green900);
      sh.getRange(r, 2).setValue(t).setBackground('#FFFFFF');
      sh.setRowHeight(r, 32);
      r++;
    });
    r++;
  });
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
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Planilha ainda não criada. Rode criarPlanilhaNova() no editor do Apps Script.');
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
