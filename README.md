# Bloco do 22 Recife — Reserva de camisas

Site de reserva da camisa oficial (R$ 22,00). **Sem pagamento online e sem entregas**:
pagamento e retirada exclusivamente no Comitê da Direita Pernambucana — Av. Herculano Bandeira, 766, Pina, Recife/PE (seg. a sáb., 9h–18h).

```
site/              → site estático (HTML/CSS/JS puro, sem build)
  index.html
  css/styles.css
  js/config.js     → URL do backend (Apps Script)
  js/app.js        → formulário, validação, tela de sucesso, comprovante
  img/             → fotos otimizadas (webp + jpg)
apps-script/       → backend no Google Apps Script
  Code.gs
  appsscript.json
```

## 1. Backend (Google Sheets + Apps Script)

Planilha: **Bloco do 22 — Reservas de camisas** (ID em `APP.SPREADSHEET_ID`; cópia em `planilha/bloco22-reservas.xlsx`,
gerada por `planilha/gerar_planilha.py`).

1. Abra o projeto do Apps Script, apague o conteúdo e cole `apps-script/Code.gs`. Salve.
2. Rode **`ativar`** (autorize). Ela cria as caixinhas, reescreve as fórmulas, adiciona os avisos de proteção
   e instala a automação do Balcão e do Status.
3. **Implantar → Gerenciar implantações → ✏️ → Nova versão → Implantar** (a URL do site não muda).

Funções úteis no editor: `verPlanilha` (link + saldo) e `testarReserva`.

### Abas da planilha
| Aba | Para quê |
|---|---|
| **Painel** | Reservas, camisas reservadas/entregues, valores e estoque por tamanho (só fórmulas) |
| **Balcão** | Atendente digita código ou WhatsApp, confere e marca **Entregue** (registra atendente e hora) |
| **Reservas** | Uma linha por pedido: P, M, G, GG, total e **Status** (Reservado / Entregue / Cancelado) |
| **Configurações** | Preço, camisas por pessoa, **Reservas abertas** (caixa) e **estoque por tamanho** |
| **Como usar** | Guia da equipe |

## 2. Site

1. Abra `site/js/config.js` e cole a URL `/exec` em `API_URL`.
   Enquanto estiver vazia, o site mostra uma faixa preta de **MODO DEMONSTRAÇÃO** e não grava nada.
2. Publique a pasta `site/` em qualquer hospedagem estática (Vercel, Netlify, GitHub Pages, Hostinger…).
3. Faça uma reserva de teste e confira se a linha apareceu na planilha.

Para testar localmente:

```bash
python3 -m http.server 5522 -d site
```

## 3. Operação diária (equipe do Comitê)

Tudo pela aba **Balcão**: digite o código (B22-…) ou o WhatsApp, confira, receba e marque **Entregue**.
A reserva vale **2 dias, até as 18h** (contando de 15/10 para quem reservou antes), nunca depois de 22/10; depois de 22/10 às 18h o site fecha sozinho. Vencida, vira **Expirado**
sozinha (gatilho de hora em hora), a camisa volta ao estoque e a pessoa pode reservar de novo.
Quem desistir: na aba Reservas, Status = **Cancelado** (as camisas voltam ao estoque).

## Estoque

Retirada a partir de 15/10, todos os dias, 9h–18h. Inicial: **P 150 · M 250 · G 400 · GG 200** (1.000 camisas), editável na aba Configurações.
Saldo = estoque − camisas de reservas não canceladas. O site mostra "Últimas N" (≤ 20) e "Esgotado",
e o servidor recusa reservas acima do saldo. Desmarcar "Reservas abertas" trava o site.

## Regras implementadas

- 1 camisa por pessoa (por WhatsApp, somando reservas não canceladas), tamanhos P, M, G e GG.
- Nome completo e WhatsApp (celular com DDD) obrigatórios.
- Caixa de confirmação obrigatória com o texto oficial — sem ela o botão fica desabilitado e o servidor recusa.
- Preço e total recalculados **no servidor** (o site não define o valor gravado).
- Código único `B22-XXXXX` (sem caracteres ambíguos como 0/O, 1/I), gerado com trava para evitar duplicidade.
- Proteções: campo isca anti-robô, limite de 3 reservas por WhatsApp por hora, bloqueio de injeção de fórmulas na planilha.
- Tela de sucesso com código, tamanhos, quantidades, total, local de retirada, botão **Como chegar** (Google Maps), **Salvar comprovante** (imagem PNG) e **Compartilhar** (WhatsApp / menu do celular).
- A última reserva fica salva no navegador ("Ver minha reserva B22-…").
- Para encerrar as reservas: em `Code.gs`, `RESERVATIONS_OPEN: false` e publique nova versão.
