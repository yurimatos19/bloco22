# Bloco do 22 Recife — Reserva de camisas

Site de reserva da camisa oficial (R$ 22,00). **Sem pagamento online e sem entregas**:
pagamento e retirada exclusivamente no Comitê de Gilson Machado — Av. Herculano Bandeira, 766, Pina, Recife/PE (seg. a sáb., 9h–18h).

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

Planilha: **Bloco 22 — Controle de Reservas** (abas PAINEL, RESERVAS, ITENS, CONFIG, GUIA).

1. Abra a planilha → **Extensões → Apps Script**.
2. Apague o conteúdo e cole `apps-script/Code.gs`. Salve.
3. Selecione **`verificarPlanilha`** → **▶ Executar** → autorize. Deve aparecer "Tudo certo ✅" no registro.
4. (Opcional) Rode **`testarReserva`** e confira a linha nova em RESERVAS e ITENS. Apague depois.
5. **Implantar → Nova implantação → App da Web** — Executar como: **Eu** · Acesso: **Qualquer pessoa**.
6. Copie a URL que termina em `/exec`.

> Ao alterar o `Code.gs`: **Implantar → Gerenciar implantações → Editar → Nova versão** (mantém a mesma URL).

O que o script grava:
- **RESERVAS** (a partir da linha 6): Código, Data/hora, Nome, WhatsApp, Resumo ("2x M, 1x GG"), Qtd., Entregue? = "Não". Total (G) e Status (H) continuam sendo fórmulas.
- **ITENS**: uma linha por tamanho do pedido (Código, Tamanho, Quantidade) — alimenta o PAINEL por tamanho.
- Preço e máximo por reserva são lidos de **CONFIG!B5** e **CONFIG!B6**.

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

1. Busque o **código** ou o **telefone** na aba RESERVAS (Ctrl+F).
2. Confira nome, tamanhos (coluna "Camisas (resumo)") e o Total.
3. Receba o pagamento e entregue **todas** as camisas do pedido.
4. Mude **Entregue?** para **Sim** — a "Data/hora retirada" é preenchida sozinha. Preencha o Atendente.
5. Acompanhe totais e pendências por tamanho na aba **PAINEL**.

## Regras implementadas

- Carrinho tradicional: escolhe o tamanho → "Adicionar ao carrinho", uma camisa por linha (com lixeira), até 3 por reserva, tamanhos PP a XXG combináveis.
- Nome completo e WhatsApp (celular com DDD) obrigatórios.
- Caixa de confirmação obrigatória com o texto oficial — sem ela o botão fica desabilitado e o servidor recusa.
- Preço e total recalculados **no servidor** (o site não define o valor gravado).
- Código único `B22-XXXXX` (sem caracteres ambíguos como 0/O, 1/I), gerado com trava para evitar duplicidade.
- Proteções: campo isca anti-robô, limite de 3 reservas por WhatsApp por hora, bloqueio de injeção de fórmulas na planilha.
- Tela de sucesso com código, tamanhos, quantidades, total, local de retirada, botão **Como chegar** (Google Maps), **Salvar comprovante** (imagem PNG) e **Compartilhar** (WhatsApp / menu do celular).
- A última reserva fica salva no navegador ("Ver minha reserva B22-…").
- Para encerrar as reservas: em `Code.gs`, `RESERVATIONS_OPEN: false` e publique nova versão.
