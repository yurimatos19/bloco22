/**
 * BLOCO DO 22 — Backend de reservas (Google Apps Script)
 * Planilha: "Bloco_22_Controle_Simplificado" (abas PAINEL, RESERVAS, ITENS, CONFIG, GUIA)
 *
 * O site envia a reserva → este script valida tudo e grava:
 *   • RESERVAS: 1 linha por pedido (Código, Data/hora, Nome, WhatsApp, Resumo, Qtd., Entregue? = "Não")
 *   • ITENS:    1 linha por tamanho do pedido (Código, Tamanho, Quantidade)
 * As colunas com fórmula (RESERVAS G/H e ITENS D) são preservadas.
 *
 * Na retirada, a equipe muda "Entregue?" para "Sim" e a Data/hora retirada é preenchida sozinha.
 *
 * INSTALAÇÃO: depois de colar, rode a função `configurar` UMA VEZ pelo editor (autoriza o acesso
 * e instala o gatilho da data de retirada). Depois publique uma nova versão da implantação.
 */

const CONFIG = {
  // Planilha "Bloco 22 — Controle de Reservas" (ID que aparece na URL dela)
  SPREADSHEET_ID: '11P3Rq-LY1kX_6BSaXmT2Ywc7oV8Mf3cTtlsLFl--3Lc',
  SHEET_RESERVAS: 'RESERVAS',
  SHEET_ITENS: 'ITENS',
  SHEET_CONFIG: 'CONFIG',
  FIRST_DATA_ROW: 6,                // linha 5 = cabeçalho
  SIZES: ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XXG'],
  DEFAULT_PRICE: 22,                // usado se CONFIG!B5 estiver vazio/inválido
  DEFAULT_MAX: 3,                   // usado se CONFIG!B6 estiver vazio/inválido
  CODE_PREFIX: 'B22-',
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // sem 0/O/1/I
  CODE_LENGTH: 5,
  // Anti-abuso: no máximo N reservas por WhatsApp a cada janela de tempo
  RATE_LIMIT_MAX: 3,
  RATE_LIMIT_WINDOW_SEC: 60 * 60,
  // Para encerrar as reservas, mude para false e publique uma nova versão.
  RESERVATIONS_OPEN: true,
};

// Colunas da aba RESERVAS (1 = A)
const R = { CODIGO: 1, DATA: 2, NOME: 3, WHATS: 4, RESUMO: 5, QTD: 6, TOTAL: 7, STATUS: 8, ENTREGUE: 9, ATENDENTE: 10, RETIRADA: 11, OBS: 12 };
// Colunas da aba ITENS
const I = { CODIGO: 1, TAMANHO: 2, QTD: 3, ENTREGUE: 4 };

/* ------------------------------------------------------------------ */
/* Endpoints                                                          */
/* ------------------------------------------------------------------ */

function doGet() {
  const s = settings_();
  return json_({ ok: true, open: CONFIG.RESERVATIONS_OPEN, price: s.price, max: s.max });
}

function doPost(e) {
  try {
    if (!CONFIG.RESERVATIONS_OPEN) {
      return json_({ ok: false, error: 'As reservas estão encerradas no momento.' });
    }

    let data;
    try {
      data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      return json_({ ok: false, error: 'Requisição inválida.' });
    }

    // Honeypot: robôs preenchem campos ocultos.
    if (data.website) return json_({ ok: false, error: 'Requisição inválida.' });

    const s = settings_();
    const v = validate_(data, s.max);
    if (v.error) return json_({ ok: false, error: v.error });

    if (!checkRateLimit_(v.phone)) {
      return json_({ ok: false, error: 'Muitas reservas para este WhatsApp em pouco tempo. Tente novamente mais tarde.' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const reservation = saveReservation_(v, s.price);
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
/* Gravação                                                           */
/* ------------------------------------------------------------------ */

function saveReservation_(v, price) {
  const ss = ss_();
  const shR = mustGet_(ss, CONFIG.SHEET_RESERVAS);
  const shI = mustGet_(ss, CONFIG.SHEET_ITENS);

  const code = uniqueCode_(shR);
  const now = new Date();
  const sizes = CONFIG.SIZES.filter(s => v.items[s]);
  const resumo = sizes.map(s => v.items[s] + 'x ' + s).join(', ');

  // --- RESERVAS: A–F + I (Entregue? = Não). G/H são fórmulas.
  const r = firstEmptyRow_(shR, R.CODIGO);
  shR.getRange(r, R.WHATS).setNumberFormat('@');
  shR.getRange(r, R.DATA).setNumberFormat('dd/MM/yyyy HH:mm');
  shR.getRange(r, R.CODIGO, 1, 6).setValues([[
    code, horaRecife_(now), safe_(v.name), formatPhone_(v.phone), resumo, v.qty,
  ]]);
  setListValue_(shR.getRange(r, R.ENTREGUE), 'Não', ['Não', 'Sim']);
  ensureFormula_(shR, r, R.TOTAL, '=IF(A{r}="","",F{r}*CONFIG!$B$5)');
  ensureFormula_(shR, r, R.STATUS, '=IF(A{r}="","",IF(I{r}="Sim","ENTREGUE","PENDENTE"))');

  // --- ITENS: 1 linha por tamanho. D é fórmula.
  let ri = firstEmptyRow_(shI, I.CODIGO);
  sizes.forEach(size => {
    shI.getRange(ri, I.CODIGO).setValue(code);
    setListValue_(shI.getRange(ri, I.TAMANHO), size, CONFIG.SIZES);
    shI.getRange(ri, I.QTD).setValue(v.items[size]);
    ensureFormula_(shI, ri, I.ENTREGUE,
      '=IF(A{r}="","",IFERROR(IF(VLOOKUP(A{r},RESERVAS!$A$6:$I$2000,9,FALSE)="Sim","Sim","Não"),"Não"))');
    ri++;
  });

  SpreadsheetApp.flush();

  return {
    code: code,
    name: v.name,
    items: sizes.map(s => ({ size: s, qty: v.items[s] })),
    qty: v.qty,
    total: Math.round(v.qty * price * 100) / 100,
    createdAt: now.toISOString(),
  };
}

// Primeira linha (a partir da 6) com a coluna de código vazia — ignora as fórmulas pré-preenchidas.
function firstEmptyRow_(sheet, col) {
  const start = CONFIG.FIRST_DATA_ROW;
  const max = sheet.getMaxRows();
  if (max >= start) {
    const vals = sheet.getRange(start, col, max - start + 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (vals[i][0] === '' || vals[i][0] === null) return start + i;
    }
  }
  sheet.insertRowsAfter(max, 50);
  return max + 1;
}

// Se a linha ainda não tiver a fórmula (ex.: passou da área pré-preenchida), escreve.
function ensureFormula_(sheet, row, col, template) {
  const cell = sheet.getRange(row, col);
  if (!cell.getFormula()) cell.setFormula(template.replace(/\{r\}/g, row));
}

// Grava um valor numa célula com lista suspensa, usando a grafia exata da lista existente
// (planilhas vindas do Excel podem ter "Não" com acentuação codificada de outro jeito).
// Se a célula não tiver lista ou recusar o valor, recria a lista e grava.
function setListValue_(cell, wanted, list) {
  const norm = x => String(x).normalize('NFC').trim().toLowerCase();
  const dv = cell.getDataValidation();
  if (dv && dv.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
    const opts = dv.getCriteriaValues()[0] || [];
    const match = opts.find(o => norm(o) === norm(wanted));
    if (match !== undefined) {
      try { cell.setValue(match); return; } catch (e) { /* recria abaixo */ }
    }
  }
  cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).build());
  cell.setValue(wanted);
}

function isValue_(x, wanted) {
  return String(x).normalize('NFC').trim().toLowerCase() === wanted.normalize('NFC').toLowerCase();
}

function uniqueCode_(sheet) {
  const start = CONFIG.FIRST_DATA_ROW;
  const last = sheet.getLastRow();
  const existing = new Set(
    last >= start ? sheet.getRange(start, R.CODIGO, last - start + 1, 1).getValues().map(x => x[0]) : []
  );
  for (let i = 0; i < 50; i++) {
    let c = CONFIG.CODE_PREFIX;
    const hex = Utilities.getUuid().replace(/-/g, '');
    for (let j = 0; j < CONFIG.CODE_LENGTH; j++) {
      c += CONFIG.CODE_ALPHABET[parseInt(hex.substr(j * 2, 2), 16) % CONFIG.CODE_ALPHABET.length];
    }
    if (!existing.has(c)) return c;
  }
  throw new Error('Falha ao gerar código único');
}

// Lê preço (CONFIG!B5) e máximo por reserva (CONFIG!B6).
function settings_() {
  const sh = ss_().getSheetByName(CONFIG.SHEET_CONFIG);
  let price = CONFIG.DEFAULT_PRICE, max = CONFIG.DEFAULT_MAX;
  if (sh) {
    const p = Number(String(sh.getRange('B5').getValue()).replace(',', '.'));
    const m = Number(sh.getRange('B6').getValue());
    if (p > 0) price = p;
    if (Number.isInteger(m) && m > 0) max = m;
  }
  return { price: price, max: max };
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
    if (CONFIG.SIZES.indexOf(k) === -1 || !Number.isInteger(n) || n < 0) {
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

function checkRateLimit_(phone) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + phone;
  const count = Number(cache.get(key) || 0);
  if (count >= CONFIG.RATE_LIMIT_MAX) return false;
  cache.put(key, String(count + 1), CONFIG.RATE_LIMIT_WINDOW_SEC);
  return true;
}

/* ------------------------------------------------------------------ */
/* Automação no Comitê                                                */
/* ------------------------------------------------------------------ */

/**
 * Gatilho instalado por `configurar()`: ao marcar "Entregue?" = Sim na aba RESERVAS,
 * preenche a "Data/hora retirada" automaticamente. Se voltar para "Não", limpa a data.
 */
function aoEditar(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== CONFIG.SHEET_RESERVAS) return;
  if (range.getColumn() > R.ENTREGUE || range.getLastColumn() < R.ENTREGUE) return;

  const first = Math.max(range.getRow(), CONFIG.FIRST_DATA_ROW);
  const last = range.getLastRow();
  if (last < first) return;

  const n = last - first + 1;
  const codes = sheet.getRange(first, R.CODIGO, n, 1).getValues();
  const flags = sheet.getRange(first, R.ENTREGUE, n, 1).getValues();
  const dates = sheet.getRange(first, R.RETIRADA, n, 1);
  const out = dates.getValues().map((row, i) => {
    if (!codes[i][0]) return [row[0]];
    if (isValue_(flags[i][0], 'Sim')) return [row[0] || horaRecife_(new Date())];
    if (isValue_(flags[i][0], 'Não')) return [''];
    return [row[0]];
  });
  dates.setNumberFormat('dd/MM/yyyy HH:mm').setValues(out);
}

/* ------------------------------------------------------------------ */
/* Ferramentas (rodar pelo editor)                                    */
/* ------------------------------------------------------------------ */

/**
 * RODE UMA VEZ pelo editor: confere a planilha, autoriza o acesso e instala o gatilho
 * que preenche a data de retirada. Pode rodar de novo sem problema (não duplica o gatilho).
 */
function configurar() {
  verificarPlanilha();
  ss_().setSpreadsheetTimeZone('America/Recife'); // datas no horário de Recife
  Logger.log('Fuso da planilha: America/Recife ✅');
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'aoEditar')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('aoEditar').forSpreadsheet(CONFIG.SPREADSHEET_ID).onEdit().create();
  Logger.log('Gatilho da data de retirada instalado ✅');
}

/** Confere se as abas e cabeçalhos esperados existem. */
function verificarPlanilha() {
  const ss = ss_();
  const shR = mustGet_(ss, CONFIG.SHEET_RESERVAS);
  const shI = mustGet_(ss, CONFIG.SHEET_ITENS);
  mustGet_(ss, CONFIG.SHEET_CONFIG);
  const hR = shR.getRange(5, 1, 1, 12).getValues()[0];
  const hI = shI.getRange(5, 1, 1, 4).getValues()[0];
  if (hR[0] !== 'Código' || hR[8] !== 'Entregue?') throw new Error('Cabeçalho da aba RESERVAS (linha 5) diferente do esperado: ' + hR.join(' | '));
  if (String(hI[0]).indexOf('Código') !== 0 || hI[1] !== 'Tamanho') throw new Error('Cabeçalho da aba ITENS (linha 5) diferente do esperado: ' + hI.join(' | '));
  const s = settings_();
  Logger.log('Tudo certo ✅  Preço: R$ %s · Máximo por reserva: %s', s.price, s.max);
}

/** Cria uma reserva de teste (aparece nas abas RESERVAS e ITENS). Apague a linha depois. */
function testarReserva() {
  const res = saveReservation_({
    name: 'Teste do Sistema',
    phone: '81999990000',
    items: { M: 2, GG: 1 },
    qty: 3,
  }, settings_().price);
  Logger.log(JSON.stringify(res));
}

/* ------------------------------------------------------------------ */
/* Utilitários                                                        */
/* ------------------------------------------------------------------ */

// Data/hora no horário de Recife, como texto que o Sheets converte em data
// (fica certo mesmo se o fuso da planilha estiver errado).
function horaRecife_(d) {
  return Utilities.formatDate(d, 'America/Recife', 'yyyy-MM-dd HH:mm:ss');
}

function ss_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function mustGet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Aba "' + name + '" não encontrada na planilha.');
  return sh;
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
