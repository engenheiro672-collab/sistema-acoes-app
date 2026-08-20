# Sistema de Sorteios "Premios Derrets" — Resumo Completo do Projeto

> Este documento é um resumo de tudo que foi construído numa longa série de conversas com o Claude.
> Use como "Instruções do Projeto" e/ou suba junto com os arquivos do sistema como conhecimento do Projeto.

## O que é o sistema

Uma plataforma de venda de títulos/cotas numeradas para participação em sorteios online (rifas). Site em português do Brasil, focado em tráfego pago (Meta/Instagram/WhatsApp).

## Stack técnica

- **Backend**: Node.js + Express (ES Modules), rodando no Render.com
- **Banco de dados**: Supabase (Postgres)
- **Pagamento**: Mercado Pago (PIX)
- **Frontend**: HTML/CSS/JS puro com jQuery (sem framework — já tentamos migrar pra React uma vez e revertemos, ver seção "Decisões importantes")
- **Sem processo de build**: tudo é servido direto como arquivo estático

## Estrutura de arquivos principal

```
server.js                          → backend inteiro (~2900+ linhas)
database.sql                       → schema completo + bloco de sincronização (roda seguro em qualquer estado do banco)
public/
  index.html                       → página inicial (lista de sorteios, busca de bilhetes)
  sorteio.html                     → página do sorteio (tema escuro) — a principal
  checkout.html                    → página de pagamento (tema escuro)
  dashboard.html                   → painel administrativo
  login.html                       → login do painel
  sw.js                            → Service Worker (cache de bibliotecas + páginas)
  css/tailwind-estatico.css        → CSS próprio (substituiu o Tailwind CDN, por performance)
  funis/
    funil-01.html                  → variação clara/branca do sorteio.html (mesma função, tema diferente)
    checkout-funil-01.html         → variação clara do checkout.html
  termos-de-uso.html               → documento legal
  politica-de-privacidade.html     → documento legal
```

**Importante**: `funil-01.html` e `checkout-funil-01.html` são cópias quase idênticas de `sorteio.html`/`checkout.html`, só com tema de cores diferente (branco em vez de escuro). **Qualquer mudança feita num precisa ser replicada manualmente no outro** — não são a mesma página com CSS condicional, são arquivos separados. Isso já causou bugs de "esqueci de replicar" várias vezes — sempre perguntar/lembrar de replicar dos dois lados.

## Decisões importantes (não repetir erros já resolvidos)

1. **React foi tentado e revertido**: reconstruímos `sorteio.html` inteiro em React (via CDN, sem build) pra tentar ganhar velocidade. Depois de várias rodadas de regressões (recursos faltando, bugs difíceis de rastrear), o usuário pediu pra reverter tudo de volta pro jQuery original. **Não sugerir React de novo** a menos que explicitamente pedido — o histórico já mostrou que não valeu a pena pro nível de complexidade do projeto.

2. **Velocidade**: já passamos por várias rodadas extensas de otimização — compressão gzip (implementada manualmente com `zlib`, sem pacote `compression` porque não há acesso à internet no ambiente de build), imagens convertidas pra WebP na compressão, scripts jQuery movidos pra depois do conteúdo visível (não travam mais a renderização), dados do sorteio embutidos diretamente no HTML pelo servidor (elimina uma ida-e-volta ao banco), consultas ao banco paralelizadas onde possível, Service Worker cacheando bibliotecas e páginas pra segunda visita ser instantânea. **Descoberta importante**: no navegador interno do Instagram (iOS), existe um atraso de inicialização da própria plataforma (WKWebView) que não é fixável via código — é limitação do iOS/Meta, confirmado via pesquisa.

3. **Bug grave da roleta (resolvido)**: uma trava única no banco de dados (`idx_roleta_giros_sorteio_numero`) impedia que qualquer cliente, exceto o primeiro de cada sorteio, ganhasse giro de roleta — falhava silenciosamente. Corrigido trocando pra `idx_roleta_giros_pedido_numero` (único por pedido, não por sorteio inteiro).

4. **Sistema de rastreio de links ("link cravado")**: implementado com cookies (não localStorage) — o servidor decide, antes de qualquer contagem de acesso, se redireciona a pessoa pro link que ela já tinha "cravado" antes (evita contar acesso duplicado). Regra: o link oficial nunca sobrescreve uma atribuição já cravada; qualquer link com código de rastreio (`?lk=`) sempre assume prioridade (último clique vence). Isso vale tanto pra links de WhatsApp/Instagram quanto pra funis.

5. **Domínio do painel bloqueado**: o painel administrativo roda num subdomínio separado (`panthers.premiosderrets.com.br`), travado pra só responder `/`, `/login`, `/logout`, `/api/admin/*`. Qualquer link gerado pelo SISTEMA (não só pelo painel) precisa usar `DOMINIO_PUBLICO_SERVIDOR` (constante fixa em `server.js`), nunca `req.get('host')` — já tivemos bug de links saindo com o domínio errado por causa disso.

## Funcionalidades principais já construídas

- **Compra de cotas**: seleção de quantidade → confirmação de telefone (detecta cliente conhecido) → dados adicionais se necessário (nome, CPF, e-mail, endereço — configurável por sorteio) → tela de confirmação final → pagamento PIX
- **Bilhetes premiados**: números específicos marcados como premiados no sorteio; ao serem vendidos, o comprador é automaticamente contemplado
- **Roleta instantânea**: giro garantido a cada compra (configurável), com prêmios; combos de "compre X títulos, ganhe Y giros" — válidos automaticamente a partir da 2ª compra do cliente, ou ao clicar explicitamente num combo
- **Chance em Dobro**: janela de tempo em que a quantidade de títulos é dobrada automaticamente
- **Promoções**: combos de desconto fixos, mostrados na página do sorteio
- **Upsell** (aba própria no painel): ofertas mostradas SÓ na hora de confirmar a compra (não na página do sorteio) — uma pra primeira compra (só desconto), outra pra segunda compra em diante (desconto + giros de roleta bônus). Sempre mostra a primeira oferta cadastrada cujo valor fique acima do que a pessoa já está levando.
- **Criar Novo Pedido** (painel): admin cria pedido manualmente, incluindo opção de "puxar" uma cota específica pra esse pedido (rouba de outro pedido se já estiver ocupada, dando um número aleatório novo pro pedido que perdeu)
- **Links de rastreamento**: comparativo de links no painel, com atribuição "cravada" (ver seção 4 acima)
- **Notificação Push**: banner de ativação, disparos manuais pelo painel

## Estado atual / próximos passos

O usuário está no meio de refinar o **layout do checkout e da tela de confirmação da roleta/upsell** — queria mandar fotos/exemplos de referência visual pra chegar num resultado "100%", mas essa conversa atingiu o limite de anexos. Esse é o motivo de estar migrando pra um Projeto novo.

**Design já implementado na tela de confirmação de compra** (dentro do modal, etapa final antes de pagar):
- Cartão de oferta (upsell) com gradiente verde, escurece quando a chavinha é ativada, mostra preço riscado + preço novo
- Ícone de confirmação em SVG (não mais texto "✓", que renderizava mal em alguns celulares)
- Seção "seus dados" com ícone de avatar, telefone parcialmente mascarado (••••)
- Bloco de regulamento/avisos legais no rodapé das páginas de sorteio, com transparência reduzida

**Isso ainda estava sendo ajustado quando a conversa foi interrompida** — o usuário quer mandar referências visuais de concorrentes pra refinar ainda mais.

## Como o Claude tem trabalhado neste projeto (preferências do usuário)

- Sempre **testar/validar antes de entregar** (`node --check`, verificação de sintaxe, IDs duplicados) — o usuário já pegou várias entregas com bugs no passado e isso gerou frustração real
- Quando o usuário pede pra investigar um bug difícil, **adicionar logs de diagnóstico** em vez de ficar "chutando" — isso já resolveu pelo menos dois bugs graves (roleta duplicada, roleta não aparecendo)
- **Sempre replicar mudanças nos dois temas** (sorteio.html + funil-01.html, checkout.html + checkout-funil-01.html) — perguntar se não tiver certeza se a mudança deve valer pros dois
- O usuário prefere ser avisado com honestidade quando algo é uma limitação de plataforma (ex: navegador do Instagram) em vez de receber mais uma tentativa de correção que não vai resolver
- Entregas devem vir com o zip completo do projeto, e uma tabela clara de quais arquivos precisam ser substituídos
- O usuário roda `git add . / git commit / git push` no Mac pra subir as mudanças — não esquecer de lembrar de extrair o zip e substituir os arquivos ANTES de rodar esses comandos

## Lembrete técnico sobre o ambiente de trabalho

O Claude que está te ajudando trabalha com um sandbox que **não tem acesso à internet** pra instalar pacotes novos via npm — por isso algumas soluções (como a compressão gzip) foram implementadas manualmente com módulos nativos do Node, em vez de instalar bibliotecas prontas.
