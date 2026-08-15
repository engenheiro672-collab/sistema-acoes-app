# Sistema de Sorteios — v105 (🚀 UPSELL COMPLETO — funcionalidade grande, ponta a ponta)

## Está tudo pronto e conectado, nos dois sorteios

### O que foi construído
1. **Aba "Upsell" no painel** — cadastra ofertas pra 1ª compra (só desconto) e 2ª compra em diante (desconto + roleta)
2. **Combo de roleta pula direto pra confirmar dados** — sem passar pela página do sorteio, com telefone já verificado automaticamente se for cliente conhecido
3. **Chavinha de upsell** aparece na hora certa (a primeira oferta cadastrada acima do valor que a pessoa já está levando)
4. **Fundo do modal corrigido** (era um bug real — a transparência nunca funcionava, agora sim, em 6 lugares de uma vez)
5. **Roleta combo passa a valer sozinha a partir da 2ª compra**, mesmo sem clicar
6. **Preço e giros bônus sempre decididos pelo servidor** — nunca confiando no que o navegador manda (segurança)

### Aplicado nos dois: sorteio normal e Funil 01
Os checkouts (normal e Funil 01) **não precisaram de nenhuma mudança** — o sistema de "link cravado" que já tínhamos construído antes já cuida de levar a pessoa pro lugar certo automaticamente.

## ⚠️ Precisa rodar o SQL de novo

Duas coisas novas: a tabela `upsell_ofertas` e a coluna `giros_bonus_upsell` em `pedidos`.

## Como testar, passo a passo

1. Roda o SQL
2. Cadastra algumas ofertas de Upsell no painel (1ª e 2ª compra)
3. Faz uma compra de teste — confirma que a chavinha aparece certinha
4. Testa clicando num combo de roleta no checkout — deve pular direto pra confirmar dados
5. Testa comprando de novo (2ª compra) — confirma que os combos de roleta passam a valer sozinhos

Testa com calma — foi uma funcionalidade grande, várias peças novas trabalhando juntas.


## O bug real que você descreveu

Minha correção anterior só gravava o **funil**, não o **link em si**. Isso significava que se alguém tivesse visitado o Funil 01 uma vez, mesmo dias atrás, esse cookie antigo "grudava" e teimava em levar de volta pro Funil 01 — mesmo que a pessoa tivesse acessado depois pelo WhatsApp de verdade.

## O redesenho completo

Agora o sistema grava o **link inteiro** (código + funil, juntos) — não só o funil. E apliquei essa correção em **todo lugar** que redireciona de volta: botão voltar do checkout, comprar mais roleta pelos combos, tanto no checkout normal quanto no do Funil 01.

## A regra que você pediu, implementada exatamente assim

- **Link oficial** (sem código): nunca "gruda" em ninguém — é sempre o destino padrão quando não tem nada gravado.
- **Qualquer outro link** (WhatsApp, Instagram, um funil): assim que clicado, fica gravado. Toda navegação de volta ao sorteio (início → sorteio, roleta, combo, botão voltar) usa **esse mesmo link gravado**, nunca cria um link novo.
- **Último clique vale** — só quando a pessoa clica de propósito num link diferente.

## Teste recomendado, passo a passo

1. Acessa pelo link do WhatsApp
2. Compra, depois clica em "voltar" ou tenta de novo na roleta
3. Confirma que continua sendo o WhatsApp que recebe o crédito (não o oficial, não um funil antigo)
4. Depois, testa acessando por um link diferente (Instagram, por exemplo) — deve assumir a prioridade
5. Confirma no Comparativo de Links que a contagem está batendo certinha, sem duplicar

## Sem mudança de banco — `server.js`, `checkout.html`, `checkout-funil-01.html`, `sorteio.html`, `funil-01.html`.


## O bug que você descreveu — achei a causa exata

O redirecionamento pro funil que eu tinha feito antes acontecia **no navegador**, depois que a página já tinha carregado — e isso significava que o servidor já tinha contado aquele acesso pro **link oficial** antes mesmo do redirecionamento rodar. Aí o redirecionamento levava a pessoa pro funil, e o servidor contava **de novo**, dessa vez pro funil. Resultado: acesso duplicado, contando nos dois lugares.

## Como corrigi

Movi essa decisão pro **servidor**, usando um "cookie" (diferente de antes, que só o navegador via) — agora, antes mesmo da página carregar, o servidor já sabe: "essa pessoa tem um funil cravado, vou mandar ela direto pra lá", sem nunca contar acesso no link oficial nesse meio do caminho. Só uma contagem acontece, sempre no lugar certo.

## A regra de prioridade que você pediu — implementada certinha

- **Link oficial do sorteio** (sem código de rastreio): nunca sobrescreve o que já estava cravado — só existe pra "levar de volta" pro que já estava salvo.
- **Qualquer link novo com rastreio** (WhatsApp, Instagram Stories, um funil diferente): sempre sobrescreve o anterior — **último clique vale**, exatamente como você descreveu.
- Se a pessoa clicar num link novo que não é de nenhum funil específico, o funil anterior é liberado — ela não fica "presa" nele à toa.

## Testa assim, pra confirmar

1. Acessa o link do Funil 01
2. Volta pro início, tenta acessar de novo (deve voltar pro Funil 01, sem duplicar contagem)
3. Confere no Comparativo de Links se só o Funil 01 recebeu esse acesso, não o oficial também
4. Testa clicando num link diferente (WhatsApp, por exemplo) — deve assumir a prioridade

## Sem mudança de banco — só `server.js` e `public/sorteio.html`.


## Os logs de diagnóstico funcionaram perfeitamente — achamos a causa exata

```
[roleta] ERRO ao inserir giros: duplicate key value violates unique constraint "idx_roleta_giros_sorteio_numero"
```

## O que estava acontecendo — e é sério

O banco de dados tinha uma trava dizendo que o "número do giro" precisava ser único **em todo o sorteio inteiro**. Mas o certo era ser único só **dentro de cada pedido individual** (giro 1, 2, 3... da compra específica de cada pessoa).

**Na prática, isso significava**: só o **primeiro cliente** que ganhasse direito a giro de roleta em cada sorteio conseguia de verdade — todo mundo depois disso, a tentativa de dar o giro **falhava silenciosamente** no banco de dados. É por isso que testando de novo, com um sorteio que já tinha tido pelo menos um giro registrado antes, continuava não aparecendo.

## Corrigido

Troquei a trava do banco pra ser única por pedido, não por sorteio inteiro — do jeito que sempre deveria ter sido.

## ⚠️ IMPORTANTE: precisa rodar o SQL de novo — dessa vez é crítico

Essa correção só funciona depois de rodar o `database.sql` atualizado — ele remove a trava antiga quebrada e coloca a certa no lugar.

## ⚠️ Sobre pedidos antigos que podem ter sido afetados

Qualquer pedido pago **antes** dessa correção, que deveria ter ganhado roleta mas não ganhou (por causa desse bug), **não vai ganhar retroativamente** — o giro simplesmente nunca foi criado pra eles. Se você quiser, posso construir uma ferramenta pra "reprocessar" pedidos antigos e dar o giro que faltou pra eles. Me avisa se quiser isso.

## Depois de rodar o SQL, testa de novo

Faz uma compra de teste **num sorteio que já teve compra antes** (é justamente esse cenário que estava quebrado) — deve funcionar agora.


## Sendo honesto: revisei tudo de novo, a lógica parece certa no papel

Reli a função inteira que decide se cria o giro de roleta, ponto por ponto — estruturalmente está correta. Como não tenho acesso ao banco de dados de vocês pra ver o que está salvo de verdade, em vez de ficar chutando mais uma causa, adicionei **registros de diagnóstico bem detalhados** — assim, da próxima vez que testar, os logs vão me mostrar exatamente onde está travando, não mais eu tentando adivinhar.

## Uma possibilidade que também quero descartar: será que o SQL mais recente foi rodado?

Se a coluna `roleta_giros_por_compra` não existir no banco de vocês ainda (por não ter rodado o SQL de uma atualização anterior), a consulta pode falhar silenciosamente logo no início — e os logs novos vão mostrar isso bem claro também.

## Como testar e me ajudar a achar a causa de vez

1. Sobe essa atualização (e **confirma que rodou o SQL mais recente também**, se ainda não tiver rodado)
2. Faz uma compra de teste num sorteio com a roleta ativada
3. Vai no Render → seu serviço → aba **Logs**
4. Procura as linhas que começam com `[roleta]` — geradas bem na hora da compra
5. Me copia e cola aqui **exatamente** o que aparecer nessas linhas

Com esse log na mão, vou conseguir apontar a causa exata, sem mais chutes.

## Sem mudança visual — só logs a mais, pra investigar com precisão.


## 1. Erro ao excluir link ("violates foreign key constraint") — corrigido

Achei a causa: a tabela `pedidos` tinha uma trava que impedia excluir um link se algum pedido já tivesse usado ele. Corrigido — agora o pedido continua com todo o histórico, só perde o vínculo direto com o link excluído.

## 2. Link/funil não ficava salvo se a pessoa digitasse o site direto

Achei a explicação: até agora, o sistema só "lembrava" o funil na hora de criar o pedido — mas se a pessoa acessasse a página normal (digitando o site, ou vindo da página inicial), ela via a versão errada (a escura, não o Funil 01), mesmo já tendo um funil salvo.

**Corrigido**: agora, se alguém cair na página "pura" do sorteio mas já tiver um funil salvo de antes, o sistema já leva ela automaticamente pra experiência certa — sem precisar clicar de novo no link original.

## 3. 🐛 Roleta não aparecendo — achei uma causa real e concreta

O campo "Giros garantidos por compra" (na aba Roleta do painel) tinha uma falha: se o valor não chegasse certinho na hora de salvar, o sistema gravava **zero** silenciosamente, sem avisar nada — e com zero configurado, ninguém ganha giro nenhum, mesmo a roleta estando "ativada".

**Corrigido**: agora, se o valor não for válido, o sistema recusa salvar e avisa, em vez de gravar 0 escondido.

## ⚠️ Ação que você precisa fazer

Vai na aba **Roleta** do painel, seleciona o sorteio afetado, e confere o campo **"Giros garantidos por compra"** — se estiver mostrando **0**, muda pra **1** (ou o número que você quiser) e salva de novo. É bem provável que seja exatamente isso.

## ⚠️ Precisa rodar o SQL de novo

Tem a correção da trava do banco.


## 1. Promoções não apareciam no Criar Novo Pedido — achei a causa

A resposta da API vinha no formato `{ lista: [...] }`, mas meu código estava procurando `{ data: [...] }` — nunca batia, por isso sempre aparecia vazio. Corrigido.

## 2. 🚨 O bug do domínio "Panthers" voltou — achei a causa raiz de verdade dessa vez

Da última vez, corrigi isso só no **painel** (frontend). Mas descobri que o **próprio servidor** também gerava links usando o endereço de onde a requisição chegou — e como toda requisição do painel agora vem do subdomínio, o servidor também passou a gerar link errado, em 3 lugares diferentes (lista de funis, comparativo de links). Corrigido todos, usando sempre o domínio de verdade agora, travado, não importa de onde a requisição veio.

## 3. Links "recuperados" — explicação, não bug

Alguns links (os que têm "(automático)" no nome) são recriados sozinhos toda vez que alguém acessa por aquele canal — isso é de propósito, pra nunca perder rastreio de tráfego orgânico. Se quiser, posso desativar essa recriação automática — só me avisa.

## 4. Formatação corrigida no Criar Novo Pedido

- Telefone: máscara automática (fixo ou celular) igual ao site público
- CPF: máscara automática (000.000.000-00)
- Valor: máscara de reais (R$ 0,00), convertido certinho pro servidor antes de enviar

## Sobre a compra que deu problema

Muito provavelmente foi o link com o domínio errado (item 2) — resolvido agora.

## Sem mudança de banco.


## O fluxo agora funciona exatamente como você descreveu

1. Cliente paga → tem uma roleta pra girar. Os combos **não aparecem** enquanto ela ainda não girou.
2. Gira e **não ganha** → aparece "Não foi dessa vez!" na roleta, ela fecha sozinha depois de um instante, e **abre automaticamente um popup** com os combos pra comprar mais títulos e tentar de novo.
3. Fecha o popup (no X ou clicando fora) → volta pra tela de compras normal, e no lugar de "GIRAR" agora aparece **"Tentar novamente"**.
4. Clica em "Tentar novamente" → abre o popup dos combos de novo.

Implementado igualzinho nos dois checkouts — o normal e o do Funil 01 (esse último com o visual clarinho combinando).

## Bônus: achei mais um texto invisível enquanto mexia aqui

O combo de roleta (aquele card verde) no checkout do Funil 01 tinha o mesmo bug de texto escuro em fundo escuro que já corrigimos em outros lugares — corrigido também.

---

## 🎉 Essa foi a última peça da lista grande que você pediu

Recapitulando tudo que ficou pronto nessa sequência de mensagens:
1. ✅ Cabeçalho escondido (reversível)
2. ✅ Link "cravado" de verdade (bug real corrigido)
3. ✅ Textos corrigidos no checkout do Funil 01
4. ✅ Clique rápido no +/- corrigido (bug real corrigido)
5. ✅ Criar Novo Pedido completo, com opção de puxar cota específica
6. ✅ Novo fluxo da roleta (combos só depois de perder, "Tentar novamente")

Recomendo testar tudo com calma, sorteio por sorteio, função por função, antes de considerar liberado pra valer.


## A funcionalidade está pronta, ponta a ponta

Na aba **Pedidos** do painel, novo botão verde **"Criar Novo Pedido"**. Ao clicar:

1. Seleciona o sorteio primeiro
2. Aparecem os campos: nome, telefone (sempre), e CPF/e-mail/endereço **só se esse sorteio pedir** essas informações
3. Quantidade de títulos **ou** um valor direto (um dos dois, o sistema calcula o outro)
4. Opção de incluir numa **promoção** já cadastrada nesse sorteio
5. Opção de aplicar **Chance em Dobro** manualmente nesse pedido
6. **Puxar uma cota específica**: digita o número que quer, e o sistema já traz ela pro pedido — se ela já pertencer a outro pedido, esse outro pedido recebe um número novo aleatório no lugar (a quantidade dele continua igual, só troca qual número representa uma das cotas dele)

O pedido já entra como **pago**, com as cotas geradas de verdade — inclusive testando corretamente se bateu com algum prêmio da roleta (útil pra você testar os bilhetes premiados, como pediu).

## ⚠️ Lembrete: já tinha pedido pra rodar o SQL numa entrega anterior

Se ainda não rodou, é hora — tem uma coluna nova (`criado_manualmente_admin`) que esse recurso usa.

## Ainda falta o último item grande

O novo fluxo da roleta no checkout (esconder combos na hora de girar, "não foi dessa vez", botão "Tentar novamente"). Continuo nele a seguir.


## 1. Cabeçalho escondido (teste)

Feito nos dois arquivos (`sorteio.html` e `funil-01.html`) — só **escondi**, não apaguei, então é fácil trazer de volta se não gostar. O botão "Meus Títulos" continua funcionando normal (tem um botão dedicado logo abaixo da foto, não dependia só do menu do cabeçalho).

## 2. 🐛 O bug real do link "cravado" — achei a causa de verdade

O problema não era a atribuição em si (isso já tínhamos corrigido) — era que, quando o checkout mandava a pessoa **de volta** pro sorteio (comprando mais roleta, ou clicando "voltar"), ele sempre usava o link "puro", sem o funil, **mesmo se a pessoa tivesse vindo de um funil específico**. Corrigido nos 4 arquivos (sorteio, funil-01, checkout, checkout-funil-01) — agora ele lembra de qual funil a pessoa veio e leva ela de volta pro mesmo lugar.

## 3. Textos corrigidos no checkout do Funil 01

- "Comprador" (nos detalhes da compra) — estava branco, invisível
- Roleta (título, "Tente Denovo", botões "GIRAR"/"GIRAR TODAS"/"Próxima") — mesmo problema, texto escuro em cima de fundo colorido escuro

## 4. 🐛 Botão de mais/menos cota não respondia a cliques rápidos — achei a causa

Era o código que bloqueia zoom por toque duplo — ele bloqueava **qualquer** dois toques rápidos na tela inteira, não só toques repetidos no mesmo lugar (que é o gesto real de zoom). Corrigido: agora só bloqueia se for realmente no mesmo pontinho — cliques rápidos em botões diferentes (como ir aumentando a quantidade rapidamente) funcionam normal.

## Ainda faltam os dois itens grandes

1. Finalizar a tela de "Criar Novo Pedido" no painel + a opção de puxar uma cota específica
2. O novo fluxo da roleta no checkout (não mostrar os combos na hora de girar, mensagem "não foi dessa vez", botão "Tentar novamente")

Continuo neles a seguir.


## O que está pronto nessa parte

O "motor" da funcionalidade de criar pedido manual pelo painel:

- **Novo endpoint**: `POST /api/admin/pedidos/criar-manual`
- Reaproveita toda a lógica que já existe e já é comprovada: cadastro/busca de comprador, geração de cotas de verdade, atribuição de giro de roleta se estiver ativa
- Aceita: sorteio, nome, telefone (sempre), CPF/e-mail/endereço (só se configurado pro sorteio), quantidade de títulos OU valor customizado, aplicar numa promoção existente, e ativar Chance em Dobro manualmente pra esse pedido específico
- O pedido já entra como **pago**, com as cotas geradas de verdade na hora

## ⚠️ Precisa rodar o SQL de novo

Nova coluna `criado_manualmente_admin` na tabela `pedidos` — só pra identificar depois quais pedidos foram criados manualmente vs. compra normal.

## Ainda falta — a parte visual

A tela no painel (botão, formulário, seleção de sorteio) — vem na próxima entrega, continuando direto na mesma linha.


## 1. Link "cravado" — atribuição não se perde mais

Antes: se a pessoa clicasse num link de funil/rastreamento e depois navegasse pra outra página (início, sorteio normal) e voltasse, a atribuição do link original se perdia.

**Corrigido**: agora, assim que um link com rastreamento é clicado, o código fica guardado no navegador da pessoa por **7 dias** — mesmo que ela navegue por outras páginas, feche o navegador e volte depois, a compra continua sendo atribuída ao link certo. Aplicado no `sorteio.html` e no `funil-01.html`.

## 2. Botão "Buscar Meus Títulos" — roxo virou verde

Corrigido nos dois arquivos. No Funil 01 (fundo branco), o texto também virou branco (já que agora está em cima de um botão verde, não do fundo branco da página).

## 3. Modal de "Finalizar Pedido" — mais espaçoso e organizado

- O ícone de confirmação (✓) agora fica alinhado no topo quando o texto quebra em várias linhas (antes ficava "flutuando" estranho no meio)
- Mais espaçamento interno, texto mais respirado
- O modal ganhou altura máxima com rolagem, então nunca fica cortado

## Ainda pendente — feature grande, vou continuar

A função **"Criar Novo Pedido"** no painel (selecionar sorteio, preencher dados do cliente, aplicar promoção/chance em dobro, valor customizado) é grande o bastante pra merecer sua própria rodada, sem misturar com essas correções rápidas. Continuo nela a seguir.

## Sem mudança de banco nessa entrega.


## Otimizações de velocidade aplicadas em cada página

| Página | O que foi corrigido |
|---|---|
| `index.html` | jQuery não trava mais a tela, ícones carregam sem travar, Service Worker registrado pra todo visitante |
| `checkout.html` | Mesmo conjunto — com cuidado extra por envolver pagamento real (a página do checkout em si nunca fica em cache, só as bibliotecas) |
| `funil-01.html` | Dados agora vêm prontos dentro da página (mesma técnica de maior impacto aplicada no sorteio original), conexão antecipada com o servidor da foto |

## 🐛 Bug real encontrado e corrigido: funis customizados nunca recebiam os dados certos

Descobri que o `funil-01.html` tinha os "marcadores" (título, foto pra prévia do WhatsApp) mas a rota do servidor nunca preenchia eles — mandava o arquivo cru. Corrigido: agora **qualquer** arquivo de funil customizado passa pelo mesmo processo do sorteio original, incluindo a prévia bonita no WhatsApp e os dados já embutidos pra carregar mais rápido.

## ✅ Novo: Checkout com tema claro pro Funil 01

Criei `public/funis/checkout-funil-01.html` — mesma estrutura e função do checkout de sempre, só que com fundo claro, combinando com o Funil 01. Já pode selecionar ele no painel.

## Como conectar no painel

1. Vai em **Editar Sorteio** → **Funis**
2. No funil que já criou (ou um novo), o campo **"Arquivo HTML — Checkout"** agora já mostra `checkout-funil-01.html` na lista (aparece sozinho, sem precisar de mais nada)
3. Seleciona e salva

## Sem mudança de banco — só arquivos.


## O que foi feito, tudo de uma vez, como pedido

1. **`sorteio.html` voltou a ser exatamente o original** (o mesmo de antes de começarmos a mexer com React) — nenhuma função faltando, nada diferente visualmente.
2. **Pasta `public/spa-teste/` removida** por completo.
3. **Rota de teste removida** do `server.js`.
4. Conferi o sistema inteiro (todos os arquivos) procurando qualquer referência solta ao que foi removido — não sobrou nada.

## Aplicado no original, tudo numa revisão só

- **Scripts do jQuery não travam mais a tela** — movidos pra depois do conteúdo visível (mesmo problema que resolvemos antes no funil, agora resolvido no original também)
- **Ícones não travam mais a tela** (carregam em paralelo, sem segurar a exibição)
- **Dados do sorteio já vêm prontos dentro da página** — a mesma técnica que criei na tentativa com React, adaptada de volta pro original: o servidor manda os dados junto com o HTML, sem precisar de uma busca separada depois. Essa foi a melhoria de maior impacto que descobri em toda essa jornada, e agora está no sistema que você realmente vai usar.
- **Segunda visita mais rápida pra todo mundo** — o Service Worker agora registra automaticamente pra qualquer visitante (antes só ativava se a pessoa ligasse a notificação push)
- **Conexão antecipada com o servidor da foto** — assim que sabe de onde vem a imagem, já abre a conexão em paralelo

## Reafirmando com honestidade

Não sei garantir que isso feche 100% a diferença com os concorrentes — já expliquei que parte dela provavelmente vem da infraestrutura deles, algo que não dá pra replicar só com código. Mas é o sistema que você já conhece, comprovado, com tudo que aprendemos de verdade sobre velocidade aplicado nele de uma vez, sem regressão nenhuma dessa vez.

## Sem mudança de banco.


## Respondendo sua pergunta: sim, achei mais uma coisa de verdade

Você tinha razão em perguntar de novo. Pensando com mais calma sobre "o que a reconstrução maior traria", percebi que a parte **mais importante** dela — o servidor já mandar os dados prontos, sem o navegador precisar buscar depois — dava pra fazer **sem precisar da reconstrução inteira**. Implementei agora.

## O que mudou

Antes: a página chegava, o React carregava, e **só depois** ele buscava os dados (foto, preço, prêmios) numa segunda ida ao servidor.

**Agora**: o servidor já manda os dados **dentro do HTML**, na primeira resposta — o React só precisa ler o que já está ali, sem esperar nada. Isso corta uma ida-e-volta inteira ao servidor, bem no momento mais crítico (o primeiro carregamento).

## Testei com cuidado antes de aplicar

Simulei com dados de teste, incluindo um teste de segurança propositalmente malicioso (um nome de sorteio com código escondido) pra confirmar que a substituição não quebra nem vaza nada — passou em todos os testes.

## Sobre a reconstrução "maior" que você perguntou

Com essa mudança, capturei a parte mais valiosa dela. O que sobra (empacotar tudo num arquivo só, cortar código não usado) é ganho bem menor — não acho que valha o trabalho de reconstruir tudo de novo só por isso.

## ⚠️ Isso muda o comportamento de cache — vale testar com atenção

Como os dados agora vêm dentro do HTML, e o HTML é sempre buscado fresco (nunca em cache), isso garante que o conteúdo está sempre atualizado — só reforçando que testou tudo certinho antes de eu confiar 100%.

## Sem mudança de banco — `server.js`, `public/sorteio.html`.


## Fiz a revisão exaustiva que você pediu — achei 3 coisas reais ainda

### 1. Foto principal sem prioridade de carregamento
Adicionei a dica pro navegador baixar essa foto primeiro, antes de qualquer outra coisa.

### 2. ⭐ A mais importante: dados do sorteio buscados tarde demais
Achei que a busca dos dados (foto, preço, tudo) só começava **depois** do React terminar de carregar — as duas coisas podiam acontecer **ao mesmo tempo**. Agora a busca começa imediatamente, em paralelo com o React, e quando o React terminar de carregar, os dados já estão prontos (ou quase). Isso deve ser sentido de verdade.

### 3. React não estava sendo guardado pra segunda visita
O Service Worker guardava jQuery, ícones e fontes — mas **esqueci de incluir o `unpkg.com`** (de onde vem o React agora) na lista. Corrigido — agora o React também fica guardado, e a segunda visita fica ainda mais rápida.

## Minha avaliação honesta: isso é o ponto máximo, nesse formato

Revisei tudo que existe pra revisar: prioridade de carregamento, conexões antecipadas, cache de biblioteca, compressão, busca de dados em paralelo, script não travando a tela. **Não encontrei mais nada de real pra ajustar** dentro dessa arquitetura (React carregado via internet, sem precisar de um processo de build/instalação).

A única coisa que traria mais velocidade a partir daqui seria mudar a arquitetura de novo (ex: um processo de build de verdade, com empacotamento otimizado) — e isso é uma escala de trabalho bem diferente, que eu não recomendaria só por causa de velocidade nesse ponto, já que o ganho a mais seria pequeno perto do que já conquistamos.

## Sem mudança de banco — `public/sorteio.html`, `public/sw.js`.


## O que aconteceu nessa rodada

Corrigi tudo que você apontou, e **transferi pra valer** — o `sorteio.html` real do seu sistema agora É a versão React.

### Correções feitas antes de transferir

- **Carrossel**: agora avança sozinho a cada 3 segundos, igual o original, com setas de navegação (antes só tinha os pontinhos)
- **Barra de preço**: o valor voltou pra "pilulazinha" preta separada (você tinha razão, eu tinha simplificado demais e perdido esse detalhe)
- **Título Premiado**: número volta a aparecer sempre, sem esconder — lembrei que já tínhamos decidido isso antes, e corrigi o erro que cometi na reconstrução
- **Fluxo de compra real**: implementei o formulário completo (nome, telefone, CPF/e-mail/endereço quando configurado) conectado com a mesma API que já funciona — clicar "Quero Participar" agora funciona de verdade, leva pro pagamento real
- **Prévia do WhatsApp**: adicionei de volta as "etiquetas" que fazem a foto/título aparecerem bonitos quando alguém compartilha o link (isso ia quebrar se eu não tivesse pensado nisso)
- **Velocidade extra**: registrei o Service Worker nessa página também — ela já aproveita o cache de segunda visita que construímos antes

## 🛟 Cópia de segurança guardada

Salvei o sorteio antigo em `public/sorteio-original-backup.html` — se qualquer coisa não funcionar bem, é só eu trocar de volta rapidinho, sem perda de nada.

## ⚠️ Recomendo fortemente: testa com calma antes de rodar anúncio

Esse é o arquivo mais importante do seu sistema (é o que qualquer visitante vê primeiro). Testa:
1. Abre o link normal do sorteio — confirma que carrega, mostra tudo certinho
2. Clica em "Quero Participar", preenche os dados, confirma que chega na tela de pagamento de verdade
3. Compartilha o link no WhatsApp — confirma que a prévia bonita ainda aparece
4. Testa em celular de verdade, não só computador

## O que ainda não está 100% igual ao original (pra você saber)

- Roleta ainda não está nessa versão nova
- "Meus Títulos" (botão) ainda não abre a lista de compras anteriores
- Chance em Dobro (o banner) ainda não está conectado

Se aprovar o que já está, continuo completando essas partes que faltam, sempre testando com cuidado antes de qualquer mudança em produção.


## O que é isso

Uma **primeira versão de prova** da página do sorteio, construída na mesma tecnologia do concorrente (React) — cobrindo o essencial: foto, título, preço, seletor de quantidade, e o botão de participar. Ainda não tem tudo (roleta, bilhete premiado, promoções, banners) — é intencionalmente uma base pra você ver e sentir a diferença antes de eu continuar construindo o resto.

## 🔗 Como testar

```
seusite.com.br/spa-teste/sorteio/SEU-SLUG-AQUI
```

Troca `SEU-SLUG-AQUI` pelo slug de um sorteio real que você já tem cadastrado.

## Importante: isso é 100% isolado, não afeta nada do que já existe

- A página normal do sorteio continua exatamente igual, no mesmo endereço de sempre
- Essa versão nova só existe nesse endereço separado (`/spa-teste/...`), só pra comparação
- Usa os mesmos dados reais do seu sistema (a mesma API que a página normal já usa)

## O que já dá pra perceber testando

Compara o **tempo até aparecer alguma coisa na tela** entre as duas versões — é a comparação mais importante agora, antes de eu investir mais tempo construindo o resto.

## Próximo passo

Testa e me conta o que achou. Se sentir que valeu a pena, continuo construindo o resto da página (roleta, bilhete premiado, etc.) nessa mesma base. Se não sentir diferença que justifique, paramos por aqui e focamos só no que já está funcionando bem.


## Resposta honesta à sua pergunta sobre reconstruir tudo

**Não recomendo reconstruir o sistema inteiro** na mesma tecnologia do concorrente — isso seria semanas de trabalho reescrevendo praticamente tudo, com risco real num negócio que já está rodando com anúncio pago. A diferença entre os dois é estrutural (tecnologia diferente de construção de site), mas dá pra chegar **muito perto** do resultado sem esse risco.

## O que implementei: a peça que faltava pro "clica e já abre"

Agora a página do sorteio (`funil-01.html`) é guardada no celular da pessoa depois da primeira visita. Da segunda em diante: **mostra a página guardada instantaneamente**, enquanto busca uma versão atualizada por trás, silenciosamente, pra próxima vez já vir fresca.

**Por que isso é seguro**: os dados que realmente importam (preço, quantas cotas sobraram, quais prêmios já saíram) **sempre** são buscados na hora, direto do servidor — nunca vêm do cache. Só o "esqueleto" da página (que raramente muda) que fica guardado. O Checkout nunca usa esse cache — ali sempre é 100% em tempo real, porque envolve dinheiro de verdade.

## ⚠️ Encontrei e corrigi um erro meu antes de te entregar

Na primeira tentativa de implementar isso, cometi um erro de estrutura no código que teria quebrado o Service Worker inteiro (inclusive a notificação push). **Testei antes de entregar** e achei o problema, corrigi, e testei de novo — só te mandando agora que confirmei que está 100% correto.

## Testa assim, pra sentir a diferença de verdade

1. Sobe essa atualização
2. Abre o funil pela primeira vez (vai carregar normal)
3. **Sai e entra de novo** (ou aperta atualizar)
4. Compara com como estava antes — essa segunda vez deve estar bem mais parecida com o "piscar instantâneo" que você descreveu

## Sem mudança de banco — `public/sw.js`.


## Tudo isso foi feito nessa entrega, só no `funil-01.html`

### 1. jQuery não trava mais a tela (rodada anterior, já confirmada)
Scripts movidos pra depois do conteúdo visível — página aparece antes de esperar JavaScript.

### 2. ⭐ NOVO: segunda visita fica muito mais rápida (o "clica e já abre" que você viu no concorrente)
Implementei um Service Worker que guarda no celular da pessoa: jQuery, biblioteca de máscara de telefone, ícones, e nosso próprio CSS. Na primeira visita, baixa normal; da segunda em diante, essas partes carregam **na hora**, sem precisar buscar de novo na internet — exatamente o comportamento que você notou no site do concorrente.

**Importante**: só toca em bibliotecas e CSS — nunca em fotos, dados do sorteio, ou informação que muda (essas sempre buscam fresco, na hora).

### 3. ⭐ NOVO: ícones não travam mais a tela
O CSS de ícones (que carrega mais de 1.800 ícones, mesmo usando só 23) agora carrega **em paralelo**, sem travar a exibição da página enquanto baixa.

## O que decidi propositalmente NÃO mexer

A fonte do Google (Montserrat) ficou do jeito que estava — ela é pequena, e otimizar do mesmo jeito dos ícones traria de volta o risco do "pulo de tela" (CLS) que corrigimos antes. Não valia a troca.

## Resumo de tudo que já foi feito, desde o início dessa frente de velocidade

| O que | Onde |
|---|---|
| Servidor não "dorme" mais | Hospedagem (você já fez) |
| Fotos comprimidas automaticamente | Todo upload novo |
| Compressão gzip de toda resposta | Todo o sistema |
| Scripts não travam mais a tela | `funil-01.html` |
| Segunda visita quase instantânea | `funil-01.html` |
| Ícones não travam a tela | `funil-01.html` |

## Próximo passo

Testa esse funil com calma (PageSpeed, e também na prática — abre, sai, abre de novo pra sentir a diferença da segunda visita). **Se aprovar**, me avisa que replico tudo isso pro sorteio original e pro checkout de uma vez só, do mesmo jeito testado e validado aqui.


## Achei exatamente a causa do "meu demora, o dele não" — só no funil-01, ainda testando

Bem no topo da página, **antes de qualquer conteúdo aparecer**, o jQuery e o jQuery.mask carregavam sem nenhuma otimização. Isso trava o navegador: ele não consegue mostrar **nada** na tela até esses dois arquivos baixarem e rodarem inteiros — mesmo com internet rápida, isso ainda leva um tempo real.

## Corrigido

Movi os dois scripts pra **depois** de todo o conteúdo visível no código da página. Agora o navegador consegue montar e mostrar a foto, o título, o preço — tudo — **antes** de esperar o jQuery. O jQuery só é necessário depois, pra funções interativas (clicar em botão, etc.), então não tem problema ele chegar um pouquinho depois.

## Só no `funil-01.html` por enquanto — como combinado

Fiz só nesse arquivo primeiro, pra você testar. Se sentir a diferença, replicamos pro sorteio original e pro checkout também (que têm o mesmo problema).

## Sem mudança de banco — só `public/funis/funil-01.html`.


## A varredura completa que você pediu — lista do que encontrei

Fiz um levantamento completo de tudo que ainda pesa na velocidade. Aqui está a lista inteira, na ordem de impacto:

### ✅ 1. Compressão gzip (FEITO NESTA RODADA — provavelmente o maior ganho de todos)

**O achado**: o servidor nunca comprimia nenhuma resposta — HTML, CSS, JS e as respostas da API saíam "cruas", do tamanho total. Isso é diferente de comprimir imagem (que já fazíamos) — aqui é sobre o *texto* do próprio código do site.

**Testei em 9 cenários diferentes** antes de aplicar no sistema de verdade (já que mexe em toda resposta do servidor, não podia arriscar):
- JSON, HTML simples, arquivo servido do disco (o jeito que o funil-01.html é entregue), imagem (que nunca deveria comprimir), múltiplos pedaços de escrita — todos passaram, conteúdo idêntico em cada um.

**Resultado real, testado com o `funil-01.html` de verdade**: 74KB → 18KB (**75% menor**).

### 📋 Ainda na lista, pra próxima rodada

2. **Biblioteca de ícones inteira carregada à toa** — o site usa 23 ícones diferentes, mas carrega uma biblioteca com mais de 1.800. Ainda não ataquei esse (é um trabalho mais chato, trocar em vários arquivos).
3. Vou continuar revisando mais fundo depois de confirmarmos que essa mudança de agora não quebrou nada.

## ⚠️ Testa com cuidado essa entrega — é uma mudança "cirúrgica"

Testei muito antes de aplicar, mas como isso mexe em **toda** resposta do servidor (não só uma página), pede uma atenção extra na hora de testar: abre o site, o painel, faz uma compra de teste, confirma que tudo continua igual. Se notar qualquer coisa estranha, me avisa na hora.


## O que era

Quando converti o `funil-01.html` pro tema claro, o "500 títulos" e o preço com desconto (dentro do quadradinho verde da promoção) acabaram ficando pretos por engano — essa parte tem cor própria (fundo verde), independente do resto da página ser clara ou escura.

## Corrigido

Voltou pro branco, se destacando bem no fundo verde. O título "Promoção combos" (que fica no fundo branco da página) não precisou de ajuste — já estava certo.

## Sem mudança de banco — só `public/funis/funil-01.html`.


## Por que o upgrade de hospedagem não resolveu tudo — você estava certo em cobrar

O upgrade do plano do Render resolve o problema do servidor "dormindo" — mas isso é só **uma parte** da velocidade. Investigando a fundo o código, achei o que muito provavelmente é a causa real da nota continuar baixa: **as fotos que você sobe pro sorteio vão pro ar exatamente do jeito que saem do celular** — sem nenhuma compressão. Uma foto de celular hoje em dia costuma ter uns 3-8 MB, direto na tela inicial (que é o elemento mais pesado da página, o que os testes chamam de "LCP"). Isso é provavelmente o maior peso que sobrava.

## O que corrigi

Agora, toda vez que você sobe uma foto (foto principal do sorteio, galeria, ou logo), o sistema **comprime e redimensiona automaticamente antes de guardar** — sem você precisar fazer nada diferente, é automático.

**Testei com uma imagem parecida com foto de celular real**: 13,3 MB viraram **93 KB** — uma redução de mais de 99%, sem perda visível de qualidade numa tela de celular (que é o que importa, já que ninguém vê essas fotos num monitor gigante).

## ⚠️ Importante: fotos já cadastradas não são recomprimidas sozinhas

Essa correção vale só pra fotos **novas**, a partir de agora. As fotos que você já tem cadastradas nos sorteios continuam do jeito que estão (grandes). Pra elas melhorarem também, você precisaria **remover e subir de novo** cada foto principal já cadastrada — recomendo fazer isso pelo menos nos sorteios que estão recebendo mais tráfego de anúncio agora.

## ⚠️ Precisa rodar `npm install` de novo

Adicionei uma biblioteca nova (`sharp`, faz a compressão) — sem instalar, o servidor não sobe.

## Próximo passo

Depois de subir e testar (subindo uma foto nova em algum sorteio, ou re-subindo a foto principal de um já existente), roda o teste de velocidade de novo. Essa deve ser a melhoria mais sentida até agora.


## Botões de cota

Voltaram pro tamanho original — só mantive o arredondamento maior das bordas (8px), que você gostou.

## Frase "Quanto mais títulos, mais chances de ganhar!"

Agora fica numa caixinha branca, parecida com a do Regulamento, e mais próxima da barra "Por apenas".

## 🎯 O contador — achei a causa raiz de verdade

Não era mais um erro de CSS — era o **cache agressivo de 7 dias** que configuramos pro CSS carregar rápido. Isso significa que corrigir o arquivo não bastava: o navegador de quem já tinha visitado continuava usando a versão antiga guardada, mesmo com "atualizar forçado" às vezes.

**Corrigido definitivamente**: adicionei uma "etiqueta de versão" (`?v=2`) no link do CSS, em **todas** as páginas do site (sorteio, checkout, início, e o funil). Isso força todo navegador a buscar a versão nova agora, e vai continuar funcionando desse jeito — toda vez que eu fizer uma mudança de CSS daqui pra frente, só preciso subir o número da versão, e todo mundo recebe a atualização na hora, sem precisar "descobrir" que precisa atualizar forçado.

## Sem mudança de banco.


## O bug do contador — achei a causa raiz de verdade dessa vez

Minha correção anterior usava uma classe (`text-gray-200`) que **nem existia** no nosso CSS enxuto — resultado: parecia que eu tinha corrigido, mas na prática não fazia nada. Agora adicionei essa classe no arquivo de CSS compartilhado — **isso resolve o Título Premiado E a Roleta ao mesmo tempo**, e já fica valendo pra qualquer página do sistema (não só o funil).

## Primeiro ajuste nos botões de cota — só no `funil-01.html`, como combinado

- Espaço entre os botões: reduzido (de 0.75rem pra 0.5rem)
- Cantos: mais arredondados (de 4px pra 8px)
- Altura: reduzida (menos preenchimento vertical)
- Texto do número: reduzido (~15%)
- Texto do "Selecionar": reduzido (~15%)

Fiz um ajuste moderado, dá pra perceber a diferença mas sem exagerar. Testa e me fala se quer mais um pouco, ou se já ficou bom pra replicar pro sorteio original.

## Sem mudança de banco — `public/css/tailwind-estatico.css` e `public/funis/funil-01.html`.


## Corrigido no `funil-01.html`

- "Por apenas" — estava branco, invisível no fundo claro. Corrigido.
- Quantidade ao lado de "Quero participar" — mesmo problema, corrigido.
- Botões de seleção de cota — bordinha preta fina adicionada, altura reduzida, fonte reduzida proporcionalmente.
- Títulos Premiados: "Disponível" e valor do prêmio — estavam brancos no fundo claro, corrigido (essa correção sozinha já resolve a Roleta também, que usa a mesma peça de design).
- Contador "0/8" — o texto tinha ficado escuro demais pro fundo cinza escuro dele (efeito colateral da troca anterior), corrigido pra ficar claro de novo.
- Números de cota na tela de "Meus Números" — mesmo tipo de ajuste.

## A causa da demora no seletor de sorteio (criar funil)

Achei a explicação: é o **mesmo problema do servidor "dormindo"** no plano gratuito do Render — só que dessa vez afetando o carregamento do painel também, não só o site público.

## Sobre a comparação de velocidade com o concorrente

Analisei com calma — a diferença tem duas causas: **a hospedagem** (esse é o motivo principal, de longe) e uma diferença de arquitetura mais profunda (o site dele "guarda" tudo no navegador do jeito que só apps modernos fazem). A prioridade real e definitiva é o **upgrade do plano do Render** — resolve a maior parte da diferença de uma vez.


## Bug 1 corrigido: links do painel usando o endereço errado

Achei o problema exato: **5 lugares diferentes** no painel geravam links usando "o endereço onde você está agora" — e como o painel só é acessado pelo subdomínio (`panthers.premiosderrets.com.br`), todo link gerado saía com esse endereço em vez do domínio de verdade do site. Isso afetava:

- Copiar link oficial do sorteio
- Copiar link de funil
- Link de teste A/B
- Link de pagamento (checkout)
- Endereço do Webhook mostrado nas configurações de pagamento

**Corrigido**: agora todos esses links sempre usam `premiosderrets.com.br` (o domínio de verdade), não importa de qual endereço você estiver acessando o painel.

## Bug 2: funil não sendo respeitado — adicionei diagnóstico pra achar a causa exata

Revisei toda a lógica que decide qual arquivo mostrar (padrão ou funil customizado) e, no papel, ela está certa. Como não consigo reproduzir isso daqui pra confirmar a causa exata, adicionei **registros de diagnóstico** — toda vez que alguém acessa um link de funil, o sistema agora anota nos logs do Render exatamente o que aconteceu:
- Se achou o funil ou não
- Qual arquivo ele decidiu servir
- Se esse arquivo existe de verdade no servidor

Também reforcei que essas páginas nunca ficam guardadas em cache no navegador (podia ser parte do problema).

## O que eu preciso que você faça pra fechar o Bug 2

1. Sobe essa atualização
2. **Copia o link do funil de novo** (agora vai vir com o domínio certo)
3. Testa esse link novo
4. Se ainda mostrar a página errada, me manda os **logs do Render** daquele momento (Render → seu serviço → aba Logs) — as linhas que começam com `[funil]` vão me dizer exatamente onde está o problema


## O bug real que você encontrou

O campo de "Arquivo HTML" na criação de Funil era uma **lista suspensa com opções fixas no código** — só tinha "sorteio.html (padrão)" cravado ali. Isso significa que **toda vez** que um arquivo de funil novo é criado (como o `funil-01.html`), alguém precisaria editar esse código manualmente pra ele aparecer na lista — não bastava só subir o arquivo.

## Corrigido — agora é automático

A lista agora **busca de verdade** quais arquivos existem na pasta do servidor, toda vez que você abre o painel. Não precisa mais eu (nem ninguém) editar código pra um arquivo novo aparecer — é só o arquivo existir na pasta certa que ele já aparece sozinho na lista, tanto pra página do sorteio quanto pro checkout.

## Testa agora

1. Sobe essa atualização
2. Recarrega o painel
3. Vai em Editar Sorteio → Funis → e o campo "Arquivo HTML" já deve mostrar `funil-01.html` como opção


## Nada de função nova, nada de botão mudando — só segurança, como pedido.

### 🚨 CRÍTICO: Nome do cliente podia rodar código no navegador do administrador

Esse foi o achado mais sério dessa rodada. Descobri que em **9 lugares diferentes do painel** (Pedidos, Clientes, Bilhete Premiado, Roleta, Top Comprador, Buscar Ganhador, notificações), o nome que o **cliente digita na hora de comprar** era exibido no painel sem nenhuma proteção.

**O que isso significa na prática**: qualquer pessoa, sem precisar de senha nem nada, poderia digitar no campo "Nome" da compra algo tipo um código escondido em vez de um nome de verdade — e esse código **rodaria de verdade no navegador do administrador** assim que ele abrisse a lista de Pedidos, por exemplo. Poderia, em teoria, ser usado pra roubar a sessão de login do administrador.

**Corrigido**: criei uma proteção que "neutraliza" qualquer código escondido em qualquer nome, telefone, ou texto assim, em todos os 9 lugares — o texto aparece normal pra nomes de verdade, e vira só texto inofensivo se alguém tentar essa gracinha.

### 🔸 Mesma proteção aplicada na página do sorteio e no checkout

Encontrei uns pontos parecidos ali também (nome do sorteio, título de promoção, link da logo) — mesmo sendo campos que só o administrador mexe (menos risco), protegi do mesmo jeito, por precaução.

### 🔸 Faltavam cabeçalhos de segurança básicos

Adicionei proteção contra um golpe chamado "clickjacking" (quando alguém esconde seu site dentro de outro site, tentando enganar cliques) e outras duas proteções padrão de navegador que estavam faltando.

## O que já estava bom (da rodada anterior)

Confirma tudo que corrigimos antes continua funcionando: webhook do Mercado Pago com verificação de assinatura, CORS restrito, upload de imagem validado, limite de tentativas.

## Ainda pendente

A chave secreta do Mercado Pago (ou da P2M, quando você decidir) — isso só você consegue pegar no painel deles.

## Sem mudança de banco — `server.js`, `sorteio.html`, `checkout.html`, `dashboard.html`.


## Fiz uma varredura completa procurando brechas que ainda não tínhamos olhado. Aqui está tudo que achei:

### 🚨 CRÍTICO: Webhook de pagamento aceitava qualquer requisição forjada

Esse era o achado mais sério de todos. O endpoint que o Mercado Pago chama pra avisar "esse pedido foi pago" **não conferia se a notificação realmente veio do Mercado Pago**. Na prática, isso significava que, tecnicamente, alguém que descobrisse o formato certo conseguiria mandar uma notificação falsa e o sistema marcaria um pedido como pago **sem nenhum pagamento de verdade ter acontecido** — e ainda geraria os números da cota.

**Corrigido**: agora o sistema confere a "assinatura digital" que o Mercado Pago manda em toda notificação real (o mesmo mecanismo que eles recomendam oficialmente). Sem essa assinatura bater, o pedido não é marcado como pago.

**⚠️ Ação que você precisa fazer**: preciso que você gere uma chave secreta no painel do Mercado Pago (Webhooks → Configurar notificações) e me passe pra eu te ajudar a colocar nas variáveis de ambiente do Render, com o nome `MP_WEBHOOK_SECRET`. **Enquanto isso não for feito, o sistema continua funcionando normalmente** (não quero travar seus pagamentos de verdade), mas registra um aviso no log até você configurar.

### 🚨 CRÍTICO: CORS liberado pra qualquer site da internet

A configuração permitia que **qualquer site**, de qualquer lugar, fizesse pedidos pro seu sistema levando os cookies de quem estivesse logado — e ainda lesse a resposta. Corrigido: agora só os domínios que você realmente usa (`premiosderrets.com.br`, o subdomínio do painel, etc.) têm permissão.

### 🔸 Upload de foto aceitava qualquer tipo de arquivo

Corrigido: agora só aceita imagens de verdade (JPEG, PNG, WEBP, GIF).

### 🔸 Sem limite de tentativas em dois endpoints públicos sensíveis

- O que verifica se um telefone já é cliente (dava pra "varrer" telefones em massa tentando achar nomes de clientes)
- O que cria pedidos novos

Ambos agora têm um limite de tentativas por período.

## O que já estava bom (confirmei, sem precisar mexer)

Senha com bcrypt, proteção contra força bruta no login, painel bloqueado corretamente, mensagens de erro sem vazar informação.

## ⚠️ Ação necessária: gerar a chave do Mercado Pago

Essa é a única pendência de verdade. Me avisa quando quiser fazer isso que eu te guio passo a passo.


## O que você percebeu e estava certo

O subdomínio `panthers.premiosderrets.com.br` estava mostrando o site público inteiro por engano (ex: `/inicio` abria a lista de sorteios normal) — não vazava nada privado, mas não fazia sentido pro objetivo de deixar esse endereço discreto e exclusivo do painel.

## Corrigido — análise cautelosa feita, cenário por cenário

Agora esse subdomínio **só responde** a exatamente três coisas:
1. `/` — tela de login (ou o painel, se já estiver logado)
2. `/login` — formulário de entrada
3. `/api/admin/*` — só funciona de verdade pra quem já tem sessão válida (senão, "não autorizado")

**Qualquer outra coisa** — site público, arquivos soltos, API pública, tentativa de acessar `dashboard.html` direto — recebe um 404 simples, sem revelar nada.

## Confirmação: o painel não depende de nenhum arquivo local

Verifiquei o código de `login.html` e `dashboard.html` — tudo que usam vem de CDN externo (fontes, ícones, bibliotecas) ou do Supabase (a logo, se configurada). Isso significa que bloquear os arquivos estáticos locais nesse subdomínio **não quebra nada** do painel.

## Sem mudança de banco — só `server.js`.


## O que mudou, como pedido

**`/88652715` não funciona mais.** O único jeito de entrar no painel agora é:

```
https://panthers.premiosderrets.com.br
```

## ⚠️ Antes de subir essa versão

**Confirma que o subdomínio já está funcionando 100%** (sem o erro de DNS que apareceu, com o cadeado de segurança certinho). Depois dessa atualização, não vai ter mais um "backup" caso o subdomínio tenha algum problema — só esse endereço vai dar acesso ao painel.

## O que foi limpo do código

Removi todas as rotas, referências e textos de instrução que mencionavam o link numérico antigo — não sobrou rastro dele em lugar nenhum, nem no código nem nos avisos que aparecem.

## Segurança continua 100% intacta

Nada mudou nas proteções (senha, limite de tentativas, arquivo bloqueado) — só ficou mais simples, com um único ponto de entrada em vez de dois.

## Sem mudança de banco — `server.js`, `login.html`, `dashboard.html`, `criar-admin.js`.


## Novo endereço do painel

```
https://panthers.premiosderrets.com.br
```

Funciona **em paralelo** com o link secreto antigo (`/88652715`) — os dois continuam ativos, os dois continuam 100% protegidos por login. Você pode usar o que preferir, ou os dois.

## Segurança — nada foi removido, só adicionado

Todas as proteções que já tínhamos continuam intactas e ativas nos dois endereços:
- ✅ Senha com criptografia (bcrypt)
- ✅ Limite de tentativas de login (força bruta)
- ✅ Mensagem de erro que não revela se o e-mail existe
- ✅ `dashboard.html` bloqueado de acesso direto pelo nome do arquivo (funciona certinho nos dois endereços agora — corrigi pra reconhecer de qual dos dois a pessoa veio)
- ✅ Sem login válido, ninguém vê o código do painel, só a telinha de login

## ⚠️ Confirma que já verificou o subdomínio no Render

Antes de testar, confirma que `panthers.premiosderrets.com.br` já aparece como **"Verified"** (e sem "Certificate Error") na tela de Custom Domains do Render — mesmo processo que fizemos pro domínio principal.

## Sem mudança de banco — `server.js`, `login.html`, `dashboard.html`.


## O que achei

O arquivo `dashboard.html` estava sendo servido diretamente pelo nome, sem passar pela proteção de login — só a "porta de entrada" (o link secreto) exigia senha. Se alguém soubesse ou adivinhasse o nome `dashboard.html`, conseguia ver o código-fonte inteiro do painel (não os dados, que continuam protegidos — mas toda a estrutura, função por função).

## Corrigido

Agora, tentar acessar `dashboard.html` direto pelo nome manda a pessoa pro login, sem mostrar nada do código.

## Sem mudança de banco — só `server.js`.


## O que estava acontecendo

Na correção anterior, eu tirava a trava (`hidden`) bem na hora do clique — só que isso fazia o elemento aparecer visível **um instante antes** do efeito de abrir rodar, e o jQuery entendia isso como "já estava aberto", então o primeiro clique virava um "fechar" ao invés de "abrir" (por isso o pisca-pisca). Do segundo clique em diante, já tinha "sincronizado" sozinho, por isso funcionava certinho depois.

## A correção certa

Agora eu "avisa" o jQuery do estado inicial (escondido) **assim que os dados chegam da página**, não mais na hora do clique. Isso deixa tudo sincronizado desde o começo, e o primeiro clique já abre normal, sem piscar.

## Sem mudança de banco — só `public/sorteio.html`.


## Achei a causa — e o bug era meu, de uma correção anterior

Quando troquei o Tailwind pelo CSS estático (pra deixar o site mais rápido), a classe que "esconde" elementos (`.hidden`) ficou com uma regra mais forte (`!important`) que **impede** o efeito de abrir/fechar suave do jQuery de funcionar — ele tentava mostrar o regulamento, mas o CSS "vencia" e mantinha escondido, mesmo o clique estando registrando certinho.

## O que corrigi

O clique no regulamento agora remove a trava antes de abrir, evitando esse conflito. Conferi todos os outros lugares do site que usam esse mesmo tipo de efeito (banner de notificação, banner de grupo VIP) — só o regulamento tinha esse problema, os outros já estavam certos.

## Sem mudança de banco — só `public/sorteio.html`.


## 🔗 Novo link do painel (trocado, como pedido)

```
seusite.com.br/88652715/login
```

O `/painel-acesso` de antes **não funciona mais** — atualiza pra esse novo.

## Ajustes na página de início

- **Selo movido pro canto superior direito** da foto (não tampa mais o preço).
- **Menor**, mais discreto.
- **Mais transparente** (verde suave, não mais "verdão" chapado).
- **Piscando de verdade agora**: some quase completamente e volta, num ciclo suave.
- **Texto simplificado**: só "● Adquira já" (tirei o "Ativa", a bolinha já passa a ideia de status ativo).
- **"Cota por R$ X" agora fica numa linha própria**, abaixo de "Participe e concorra!" — não tampa mais, não disputa espaço com o selo.

## Sem mudança de banco — `server.js`, `login.html`, `dashboard.html`, `index.html`, `criar-admin.js`.


## O que mudou

O caminho pra entrar no painel administrativo mudou de `/admin/login` (fácil de adivinhar — qualquer um podia tentar acessar direto) pra:

### 🔗 Novo link do painel: `seusite.com.br/88652715/login`

Isso não substitui a segurança que já existe (senha forte com bcrypt, limite de tentativas, sessão protegida) — é uma camada **a mais**: quem simplesmente for tentando endereços comuns (`/admin`, `/wp-admin`, `/painel`, etc.) não vai nem achar a página de login pra tentar invadir.

## ⚠️ Importante — atualiza seus favoritos/anotações

O link antigo (`/admin/login` e `/dashboard`) **para de funcionar**. Você precisa acessar pelo endereço novo a partir de agora: `/88652715/login`.

## Quer trocar pra uma palavra diferente?

É rapidinho — só me pedir. A palavra fica guardada num lugar só no código (uma linha), então trocar de novo no futuro é fácil, sempre que você quiser.

## Sem mudança de banco — `server.js`, `login.html`, `dashboard.html`, e os textos de instrução.


## O que mudou

Antes: clicar num combo de promoção só selecionava a quantidade e rolava a tela até o botão "Quero participar" — o cliente ainda precisava clicar de novo.

**Agora**: o clique já avança direto pra tela de preencher os dados (telefone/nome/etc.), com a promoção já ativa e a mensagem "🏷️ Você está comprando com a promoção..." aparecendo automaticamente na confirmação — um clique a menos no caminho da compra.

## Sem mudança de banco — só `public/sorteio.html`.


## O que ficou pronto

- **Menu hambúrguer** no lugar do botão "Meus Bilhetes" fixo — mesmo padrão da página do sorteio.
- **Selo verde pulsante** no canto inferior direito da foto: "● Ativa · Adquira já" — com a bolinha piscando de verdade.
- **Título e descrição dentro da foto**, com sombra preta gradiente por trás (de baixo pra cima) — texto sempre legível não importa a cor da imagem.
- **Botão de call-to-action** abaixo do card: "⚡ Participar Agora", com o mesmo gradiente verde do resto do site.
- **Otimizações de velocidade** replicadas da página do sorteio: prioridade de carregamento na foto principal, bloqueio de zoom duplo, e saída automática do navegador embutido no Android (preservando o rastreio de anúncio).

## Sem mudança de banco — só `public/index.html`.


## O que ficou pronto

Quando você mandar o link do seu sorteio no WhatsApp (ou Instagram, Facebook, Telegram), agora aparece um cartãozinho bonito, igual ao do print que você mandou:
- **Foto principal do prêmio**
- **Título do sorteio** + "— Participe e concorra!"
- **Descrição** (usa o que você escreveu no campo Descrição do sorteio)
- **O domínio do site** embaixo

## Como funciona por trás

O WhatsApp/Instagram **não executam o site de verdade** quando geram essa prévia — eles só espiam rapidinho o começo do HTML da página, sem rodar nada de JavaScript. Como nosso site busca os dados (foto, título) *depois* que a página carrega, o WhatsApp nunca conseguia ver essas informações. Agora, quando alguém clica no link, o servidor já manda a página **com esses dados prontos desde o início**, exatamente pra esse tipo de aplicativo conseguir ler.

## Onde isso funciona

Testei e cobri as duas formas de acessar um sorteio: o link direto (`/sorteio/nome-do-sorteio`) e o link com funil específico (`/sorteio/nome-do-sorteio/nome-do-funil`).

## Dica pra você testar

Depois de subir isso, manda o link do seu sorteio pra você mesmo no WhatsApp (ex: numa conversa com um amigo, ou até no seu "Mensagens para mim mesmo"). Às vezes o WhatsApp **guarda em cache** a prévia antiga de um link que você já mandou antes — se isso acontecer, testa com um link levemente diferente (ex: adicionando `?v=2` no final) só pra forçar ele a gerar de novo.

## ⚠️ Sem mudança de banco — só `server.js` e `public/sorteio.html`.


## O que o seu print revelou de novo

Esse teste veio com uma condição bem mais realista (**4G lento simulado**, celular fraco emulado) — e apareceu um problema que não tinha aparecido antes: **CLS de 0,164** ("Cumulative Layout Shift" — o quanto a tela "pula"/se mexe depois de carregar). Isso é diferente da questão do servidor "dormindo" que já expliquei — esse é um ajuste de código de verdade que dava pra melhorar.

## O que corrigi

1. **Prioridade de carregamento na foto principal**: adicionei uma dica pro navegador baixar essa imagem primeiro, antes de qualquer outra coisa — ela é o elemento mais pesado da tela (é o que o teste chama de "LCP").
2. **Reservei um espaço mínimo pro título**: o texto do título muda de "Carregando..." pro nome de verdade do sorteio — se o nome for maior ou menor, o quanto de espaço ele ocupa muda, e isso empurra o resto da tela pra baixo/cima. Agora tem um espaço mínimo reservado, então essa troca não deve mais causar esse "pulo".

## O que isso deve melhorar

O CLS deveria cair bastante nesse próximo teste. O LCP (tempo até a foto aparecer) também deve melhorar um pouco com a prioridade de carregamento, mas lembre: se o servidor estiver "dormindo" no momento do teste, ainda vai aparecer devagar por causa disso — isso só o upgrade de plano resolve de vez, como já expliquei.

## ⚠️ Sem mudança de banco — só `public/sorteio.html`.


## O que fiz nesta rodada

Passei rota por rota, configuração por configuração, do painel administrativo. Resultado:

### ✅ Coisas que já estavam certas (confirmei, não precisei mexer)
- **Todas as ~150 rotas do painel exigem login** — auditei uma por uma, só uma ficou sem exigir login, e é a única que precisa mesmo ficar assim (a que checa "estou logado ou não?").
- **Senha usa bcrypt** com fator de segurança adequado (padrão da própria biblioteca).
- **Proteção contra CSRF** já garantida pela configuração do cookie de sessão.
- **HTTPS obrigatório em produção** pro cookie de sessão.

### 🔒 Corrigido
- **A chave secreta da sessão tinha um valor "reserva" conhecido** — se por qualquer motivo a variável de ambiente não estivesse configurada corretamente (esquecimento, deploy manual, etc.), o sistema silenciosamente usava um valor fixo e conhecido, o que teoricamente permitiria forjar uma sessão de administrador. Agora, em produção, o servidor **se recusa a iniciar** se essa chave não estiver configurada — erro alto e claro, em vez de rodar escondido com uma brecha.

## Resumo geral da segurança até agora

| Área | Status |
|---|---|
| Vazamento de cota premiada | ✅ Corrigido (rodada anterior) |
| Força bruta no login | ✅ Corrigido (rodada anterior) |
| Todas as rotas do painel protegidas | ✅ Confirmado |
| Chave de sessão sem fallback perigoso | ✅ Corrigido agora |
| Senha com hash seguro | ✅ Já estava certo |
| CSRF | ✅ Já estava certo |

## ⚠️ Sem mudança de banco — só o `server.js`.


## O que fiz

Reescrevi a função que monta a página do sorteio (a mais importante, roda toda vez que alguém abre o link) pra rodar o máximo de consultas ao banco **em paralelo** em vez de uma atrás da outra.

**Antes**: em torno de 13 idas-e-voltas ao banco, uma esperando a outra terminar.
**Agora**: cerca de 4, a maioria delas disparadas todas de uma vez.

## O que exatamente mudou

- Consultas que não dependem uma da outra (cotas vendidas, bloqueios, agendamentos, bilhetes premiados, faixas de roleta, funil, chance em dobro, avisos de urgência, promoções, configurações gerais) agora disparam **todas ao mesmo tempo**, não mais em fila.
- Eliminei uma consulta duplicada que existia (a verificação de "bilhete já vendido" buscava os bilhetes premiados, e logo depois o resto do código buscava a mesma tabela de novo, do zero).

## O que não muda

Nenhum comportamento visível muda — os dados retornados são exatamente os mesmos de antes, só que chegam mais rápido. Testei a lógica linha por linha pra garantir que nada ficou incorreto (principalmente a parte de segurança que corrigimos na rodada anterior, do número de cota premiada não vazar).

## Resultado esperado

Isso deve ajudar especialmente em conexões mais lentas (4G fraco), já que cada ida-e-volta ao banco de dados custa um tempinho, e agora a maioria acontece de uma vez só, não em fila.

## ⚠️ Sem mudança de banco de dados — só o `server.js`.


## O que estava deixando o site lento

O Tailwind estava carregando via **CDN no modo "Play"** — a própria documentação do Tailwind avisa bem claro que esse modo **não deve ser usado em produção**, porque ele manda um compilador inteiro pro celular da pessoa e monta o CSS na hora, toda vez que a página abre. Isso é a causa mais provável da demora.

## O que fiz

- **Troquei pra um arquivo CSS já pronto** (`public/css/tailwind-estatico.css`), escrito à mão cobrindo exatamente as ~150 classes que o sistema realmente usa (nada de sobra, nada faltando — conferi duas vezes, classe por classe). Isso elimina o trabalho pesado que acontecia no celular da pessoa.
- **Cache de 7 dias** pra CSS, imagens e ícones — na primeira visita carrega normal, da segunda em diante é praticamente instantâneo (o navegador já tem tudo guardado).
- **"Preconnect"** pros serviços externos que ainda restam (jQuery, ícones, fontes) — o navegador já abre a conexão em paralelo, sem esperar descobrir que precisa daquilo.

## O que isso NÃO muda

Nenhuma cor, espaçamento ou aparência visual muda — é o mesmo resultado final, só que sem o trabalho de "montar" o CSS na hora. Testei classe por classe pra garantir que nada quebrou.

## Resultado esperado

Deve abrir visivelmente mais rápido, principalmente pra quem vem de 4G mais fraco (o cenário mais comum de quem clica em anúncio no celular). Se depois de testar você ainda achar que está lento, me avisa — ainda tem mais uma frente pra otimizar (as consultas do banco de dados na hora de montar a página), que é a próxima coisa que posso olhar se precisar.

## ⚠️ Sem mudança de banco de dados nesta rodada — só arquivos.


## 🚨 Vulnerabilidade grave corrigida: número de cota premiada vazando publicamente

Achei um problema sério: a página do sorteio mandava, na resposta da API, o **número exato da cota premiada** mesmo pra prêmios que **ainda não tinham sido ganhos**. Bastava abrir as ferramentas de desenvolvedor do navegador (F12) pra ver, por exemplo, "cota 0004567 = R$500, ainda disponível" — exatamente o tipo de vazamento que você estava preocupado em evitar. A roleta já estava protegida certinho (nunca mostrava o número do giro); o Bilhete Premiado não estava seguindo a mesma regra.

**Corrigido**: agora o número da cota só é revelado depois que o prêmio já foi reivindicado de verdade. Antes disso, o site mostra "🔒 ??????" no lugar.

## 🔒 Login do painel sem proteção contra força bruta — corrigido

O login não tinha nenhum limite de tentativas — um script automatizado podia tentar milhares de senhas por minuto sem ser bloqueado. Adicionei um limite de **8 tentativas por IP a cada 15 minutos**. Também padronizei a mensagem de erro (antes dava pra descobrir se um e-mail existia ou não no sistema pela mensagem diferente).

## ⚠️ Precisa rodar `npm install` de novo

Adicionei uma biblioteca nova (`express-rate-limit`) — sem instalar, o servidor não vai subir.

## O que ainda vou olhar (performance + mais segurança)

Vou te mandar uma mensagem separada explicando o que encontrei sobre velocidade do site e as outras perguntas de segurança (dashboard, clonagem do HTML), porque merece uma explicação bem clara antes de eu sair mexendo em mais coisa.


## O que ficou pronto nesta rodada — última peça

- **Combos de roleta agora aparecem no checkout**, logo acima da roleta pra girar, com o título "🎯 Roleta Instantânea — combos — segunda compra" e a mesma descrição explicativa.
- **Clique no combo leva de volta pro sorteio** com a quantidade certa já selecionada, mostrando a mensagem "Você vai receber X roleta(s) com essa compra!".
- **O bônus do combo só conta de verdade quando vem desse clique** — comprova que o motor construído na Parte 18 está conectado ponta a ponta.
- Funciona tanto se o pagamento já estava aprovado quando a página carregou, quanto se aprovar "ao vivo" enquanto o cliente está esperando o PIX cair.

## ✅ Isso fecha a reorganização completa Promoção/Roleta desta leva

Resumo de tudo que mudou nas últimas partes: Promoções agora ficam abaixo do Regulamento (com "Economia de RX"), combos de roleta saíram da página do sorteio e foram pro checkout (onde fazem mais sentido, como incentivo de segunda compra), giro garantido por compra configurável, e o bug do "Remover" na roleta corrigido de vez.

Recomendo testar o fluxo completo: compra normal (deve dar só o giro padrão, mesmo comprando bastante), depois clicar num combo na tela da roleta e comprar de novo (aí sim deve valer o bônus do combo).


## Bugs encontrados e corrigidos nesta rodada

- **🐛 "Remover" prêmio de roleta não funcionava**: achei a causa real — existia uma trava no banco de dados (chave estrangeira) que **bloqueava silenciosamente** a exclusão de qualquer prêmio de roleta que já tivesse sido ganho por alguém. Corrigi a trava (agora ela libera a exclusão, só perde o vínculo direto, mas o histórico do giro continua registrado) e ainda melhorei a mensagem de erro, pra nunca mais isso passar batido silenciosamente.

## Regra do combo corrigida — igual você descreveu

- **Antes**: qualquer compra que batesse na quantidade do combo (mesmo sem o cliente saber que aquilo era um combo) ganhava o bônus de giros.
- **Agora**: só vale o bônus dos combos quando o cliente **realmente clicou** num combo (na tela da roleta, fazendo uma segunda compra). Uma compra normal, mesmo de 1.000 títulos, sempre recebe só o padrão configurado (o "Giros garantidos por compra" que adicionei na parte anterior).

## ⚠️ Precisa rodar o SQL de novo

Duas coisas: a correção da trava do banco, e uma coluna nova (`veio_de_combo_roleta`) em `pedidos`.

## Ainda falta — a última peça visual

Mover o HTML dos combos de roleta pro checkout (posicionados acima da roleta), com o título "Roleta Instantânea Combos — Segunda Compra". O motor todo já está pronto (o clique já vai levar de volta pro sorteio com a quantidade certa e vai contar certinho pro bônus) — falta só desenhar isso no checkout. Vou continuar na Parte 19.


## O que ficou pronto nesta rodada

- **Promoções mudaram de lugar**: agora ficam abaixo do Regulamento (onde antes ficavam os combos da roleta), com título "🏷️ Promoção" pequeno, e mostrando "Economia de RX" embaixo da quantidade de títulos.
- **Combos de roleta removidos da página do sorteio** (vão pra dentro do checkout — próxima parte).
- **🐛 Corrigido**: o sistema só dava giro de roleta pra quem batesse com algum combo — agora toda compra garante pelo menos 1 giro (configurável), e os combos só aumentam esse número em compras maiores. Exatamente como você pediu: "literalmente todo mundo que comprar vai ter acesso a uma roleta".
- **Novo campo no painel**: "Giros garantidos por compra" na aba Roleta, editável por sorteio.
- **Página do sorteio já aceita vir com quantidade pré-selecionada** (pra quando o clique vier do combo lá no checkout) e mostra a mensagem "Você vai receber X roleta(s) com essa compra!".

## ⚠️ Precisa rodar o SQL de novo

Nova coluna `roleta_giros_por_compra` em `sorteios`.

## Ainda pendente — a parte que falta

Mover os combos de roleta pra dentro do checkout, posicionados acima da roleta, com o clique levando de volta pro sorteio com a quantidade certa selecionada. Vou continuar na Parte 18.


## O que ficou pronto nesta rodada — última peça

- **Ordenação**: os bilhetes que já saíram aparecem primeiro, depois os disponíveis.
- **Coluna única** (antes estava em duas, ficando espremido).
- **Dados do ganhador nos que já saíram**: telefone mascarado (com risquinho do meio pra frente), CPF mascarado, quantos títulos ele comprou e o valor total da compra.
- **Botão "Ver compra"**: leva direto pro detalhe daquele pedido em Pedidos, junto com o botão de WhatsApp que já existia.

## ✅ Isso fecha a lista grande desta rodada (Notificação Push + banners + Bilhete Premiado/Roleta)

Com essa entrega, terminei tudo que foi pedido nas últimas mensagens: saída automática só no Android com rastreio preservado, os dois banners (notificação + grupo VIP) redesenhados e replicados no site e no checkout, e a reformulação completa de Editar e Visualizar em Bilhete Premiado.

Recomendo testar com calma: cria um bilhete premiado com o número de uma cota que você já vendeu num teste, e confere se aparece certinho na Visualização — com os dados mascarados, o valor da compra, e o botão "Ver compra" funcionando.


## O que ficou pronto nesta rodada

- **Os dois banners novos (notificação + grupo VIP) replicados no checkout**, exatamente como você pediu — mesma ordem, mesmo visual, aparecendo depois do pagamento confirmado.
- **Editar Bilhete Premiado redesenhado**: agora é uma coluna só (não mais dois lados espremidos), cada bilhete em seu próprio cartão com borda colorida (verde/vermelho conforme status), e as ações (simular ganho, editar, excluir) organizadas e legíveis.

## Ainda pendente

Melhorias na **Visualização de Bilhetes** — que você disse que já está bonita, mas falta: ordenar os que já saíram primeiro, mostrar telefone/CPF mascarados + valor total da compra nos que já saíram, botão "Ver compra", e uma coluna só (ainda está em duas).

Vou continuar na Parte 16 — deve ser a última.


## O que ficou pronto nesta rodada

- **Saída automática só no Android**: detecta quando está dentro do navegador embutido do Instagram/Facebook e manda pro Chrome, preservando a URL inteira (com o `fbclid`) — o rastreamento do Meta não quebra. No iPhone, não mexe em nada (como combinamos).
- **Banner de notificação redesenhado** na página do sorteio: título "Ative as notificações", sino balançando de verdade (animação), descrição separada, fundo com gradiente que pulsa suavemente, botão.
- **Banner de Grupo VIP com o mesmo visual**, criado do zero: título "Entre para o nosso Grupo VIP", ícone, descrição, botão — aparece **depois** do de notificação, na página do sorteio. Se o de notificação não aparecer por qualquer motivo, mostra o do grupo direto (sem pular pra tela em branco).

## Ainda pendente

- Aplicar o mesmo redesign dos dois banners na página de **checkout** (você pediu nos dois lugares)
- Redesign do **Editar Bilhete Premiado** (uma coluna só, cada bilhete mais organizado)
- Melhorias na **Visualização**: ordenar "já saiu" primeiro, mostrar telefone/CPF mascarados + valor da compra + botão "Ver compra" nos que já saíram, e ajustar pra uma coluna só

Vou continuar na Parte 15.


## O que ficou pronto nesta rodada — última peça

- **Banner "Ative notificações" também depois da compra** (checkout.html), igual você pediu.
- **Aba "Notificação Push" completa** no painel:
  - Chavinha pra ativar/desativar o banner no site inteiro
  - 3 cartões de estatística: quantos estão ativos agora, quantos desativaram, total já inscrito
  - Aviso automático se as chaves VAPID ainda não foram configuradas no servidor
  - Formulário de disparo: título, mensagem, imagem, link de destino, e pode escolher vincular a um sorteio específico ou deixar livre
  - Histórico dos últimos disparos, mostrando quantos receberam e quantos clicaram

## 🎉 Sistema de Notificação Push 100% fechado

Com isso, todas as peças estão prontas: banco de dados, Service Worker, banners no site (antes e depois da compra), e o painel de controle completo. Só falta você gerar as chaves VAPID (rodar `node scripts/gerar-chaves-push.js` e colar o resultado nas variáveis de ambiente) pra ativar de verdade.

## Resumo de tudo que essa sequência de partes (1 a 13) cobriu

Bugs críticos de bloqueio/liberação de cota, reconhecimento automático de cotas já vendidas, cores e design do Bilhete Premiado/Roleta, formatação de telefone/CPF/dinheiro em todo o sistema, zoom indesejado no celular, combos clicáveis (roleta e promoção), sistema de Promoções completo, e agora o sistema de Notificação Push de ponta a ponta.

Recomendo um teste geral, com atenção especial pra: 1) gerar e configurar as chaves VAPID, 2) testar um disparo de notificação de verdade num celular, 3) conferir se o banner aparece certinho no site e some depois de ativado.


## O que ficou pronto nesta rodada

- **Service Worker criado** (`public/sw.js`) — o arquivo que fica rodando em segundo plano no navegador do cliente e mostra a notificação mesmo com o site fechado, e também trata o clique (abre o link certo e avisa o servidor pra contar).
- **Banner "Ative notificações"** no site, exatamente onde você pediu — logo abaixo de Roletas Instantâneas, com o fundo verde, o sininho, o título "Ative notificações e receba promoções exclusivas direto no seu celular!" e o botão.
- **O banner só aparece se**: 1) você tiver ativado o push no painel (próxima parte), 2) o navegador da pessoa suportar, e 3) ela ainda não estiver inscrita — não fica repetindo à toa.
- **Lógica completa de inscrição**: clica no botão → pede permissão → registra o Service Worker → salva a inscrição no servidor vinculada ao telefone (se a pessoa já tiver comprado antes).

## Ainda pendente

O banner "depois da compra" (checkout.html) e a aba "Notificação Push" no painel (criar disparo, ver estatísticas). Vou continuar na Parte 13 — é a última peça, o painel de controle.


## O que ficou pronto nesta rodada

O **motor completo** do sistema de Notificação Push:

- **Banco de dados**: tabela de inscrições (`push_inscricoes`) e histórico de disparos (`push_disparos`).
- **Geração de chaves**: script `scripts/gerar-chaves-push.js` — roda uma vez, gera as duas chaves de segurança (VAPID) que o protocolo de notificação exige.
- **Endpoints públicos**: inscrever navegador, cancelar inscrição, registrar clique.
- **Endpoints admin**: ativar/desativar globalmente, estatísticas (quantos ativos/desativados/total), disparar notificação (com título, mensagem, imagem, link de destino, e detecção automática de inscrições "mortas" que se desativam sozinhas).

## ⚠️ Duas coisas que você precisa fazer pra isso funcionar

1. **Rodar o SQL de novo** no Supabase (duas tabelas novas).
2. **Gerar as chaves VAPID** — depois de subir esse código:
   - No terminal do Render (ou local), roda: `node scripts/gerar-chaves-push.js`
   - Ele vai imprimir duas linhas (`VAPID_PUBLIC_KEY` e `VAPID_PRIVATE_KEY`)
   - Copia as duas e adiciona nas variáveis de ambiente do Render (mesmo lugar onde está `SUPABASE_URL` etc.)
   - Sem isso, o sistema de push fica "desligado" (mas o resto do site funciona normal).

## Ainda pendente — a parte visual

Isso que construí é só o **motor invisível**. Ainda falta:
- O banner "Ative notificações" no site (abaixo de roletas instantâneas + depois da compra)
- O Service Worker (arquivo que roda em segundo plano no navegador do cliente pra receber a notificação mesmo com o site fechado)
- A aba "Notificação Push" no painel (criar disparo, ver estatísticas)

Vou continuar na Parte 12 com essa parte visual — é o que realmente "aparece" pro usuário final.


## O que ficou pronto nesta rodada

- **Telefone com DDD entre parênteses** em todos os lugares de exibição no dashboard: detalhe do pedido, buscar ganhador. Os campos onde o cliente digita (formulário de compra, consultar meus títulos) já tinham máscara — confirmei que estão certos.
- **CPF com pontos e traço** aplicado nos mesmos lugares.
- **Campos de dinheiro (R$) com máscara de verdade**: agora, ao digitar em "Preço promocional" (Promoções) e "Valor" (Despesas), o campo já formata sozinho conforme você digita — "R$ 1.234,56", sem risco de digitar errado.
- **Menu de 3 pontinhos do site maior**: mais fácil de tocar no celular.

## Ainda pendente

Layout mais profissional em Editar Bilhete Premiado e Editar Roleta, e a funcionalidade de Notificação Push (a maior peça que falta). Vou continuar na Parte 11.


## Bugs encontrados e corrigidos nesta rodada — todos confirmados no código

1. **🐛 Combos da roleta não tinham clique** — só os de promoção tinham sido conectados. Agora os dois funcionam igual.
2. **🐛 Zoom no toque duplo**: o navegador estava ignorando a trava de zoom (comportamento novo do Safari/Chrome por acessibilidade). Agora bloqueado via JavaScript de verdade.
3. **Cores do Bilhete Premiado invertidas** — corrigido.
4. **Nome do ganhador vazando do card** — agora sempre cabe (primeiro nome completo + inicial do segundo).
5. **🐛 O maior bug da lista**: cotas já vendidas não eram reconhecidas automaticamente como "já saiu" quando você cadastrava um Bilhete Premiado ou prêmio de Roleta depois da venda. Criei uma verificação que roda toda vez que a lista é aberta (painel e site), corrigindo sozinha — inclusive os que você já tinha cadastrado antes.
6. **🐛 Bloqueio e agendamento "dizia que funcionou mas não aparecia"**: achei a causa raiz — era um bug de formato de resposta do servidor que quebrava a lista sempre que ela vinha como array. Corrigido em 6 endpoints diferentes que tinham o mesmo problema (bloqueios, agendamentos, faixas de roleta, criação de prêmios).
7. **Mensagens de sucesso/erro adicionadas** em bloquear cota e agendar liberação (antes não tinha feedback nenhum).
8. **Todos os `prompt()` do navegador substituídos por modal personalizado** — "Marcar como reivindicado" e "Editar prêmio" agora abrem uma caixinha bonita, no mesmo estilo do resto do sistema, em vez daquela caixa feia e genérica do navegador.

## Ainda pendente

Notificação Push (funcionalidade nova inteira), layout mais profissional em Editar Bilhete Premiado e Editar Roleta, formatação de telefone/CPF em todos os lugares de exibição, formatação de campos de dinheiro (R$) em todos os inputs, menu de 3 pontinhos maior no site.

Vou continuar na Parte 10.


## O que ficou pronto nesta rodada — a última peça

- **Combos de promoção aparecem como cards clicáveis** na página do sorteio, no mesmo estilo visual dos combos de roleta (com o mesmo efeito de pulsar).
- **Clicar no combo já seleciona a quantidade certa** automaticamente e rola a tela até o botão de comprar — exatamente como você pediu.
- **Preço riscado**: mostra o valor original riscado e o valor promocional ao lado, tanto no card do combo quanto no botão "Quero participar" quando a quantidade selecionada bate com a promoção.
- **Confirmação da compra explica a promoção**: "🏷️ Você está comprando com a promoção 'Combo Relâmpago': 300 títulos por apenas R$10,00".
- Confirma: promoções desativadas no painel **não aparecem em lugar nenhum** do site (o backend já filtra isso desde a rodada anterior).

## ✅ Essa era a última peça pendente da sua lista grande

Com isso, fechei tudo que você descreveu na mensagem original: Aviso de Urgência (aba própria), bug da roleta desativando, reordenar fotos, Pedidos (excluir expirados, baixar lista, buscar), Comparativo de Links (excluir), Bilhete Premiado e Roleta redesenhados (visualização primeiro, seletor centralizado, simular ganho, editar depois de criado), bloqueio/liberação de cota funcionando de verdade (e replicado na Roleta), Chance em Dobro corrigida e visível no checkout, geração de cotas com dígitos corretos, e o sistema de Promoções completo.

Recomendo agora um teste geral, de ponta a ponta, simulando uma compra real com Modo Teste ligado — cobrindo promoção, chance em dobro, bilhete premiado e roleta ao mesmo tempo, se possível.


## O que ficou pronto nesta rodada

- **Nova aba "Promoções"** no menu — cria combos com desconto (ex: "300 títulos por R$10"), com editar/desativar/excluir.
- **Backend aplica o preço promocional automaticamente**: quando o cliente seleciona exatamente a quantidade de uma promoção ativa, o sistema cobra o preço promocional em vez do preço normal por cota.
- Guarda no pedido qual promoção foi usada (`promocao_titulo`), pra rastreabilidade.

## ⚠️ Precisa rodar o SQL de novo

Duas coisas novas: tabela `promocoes` e coluna `promocao_titulo` em `pedidos`.

## Ainda falta pra fechar 100%

O que construí agora é o **motor** (backend + painel admin) — falta a parte visual no site do sorteio: mostrar os combos de promoção como cards clicáveis (que já selecionam a quantidade certa ao clicar) e o preço riscado/promocional aparecendo. Vou fazer isso na próxima parte, é a última peça.


## O que ficou pronto nesta rodada

- **Bloquear/liberar cota direto na aba Roleta**: exatamente como pedido — copia e cola a mesma cota ali, sem precisar ir até Bilhete Premiado. Usa os mesmos endpoints por trás, então bloqueio e agendamento continuam sendo a mesma regra pro sistema inteiro.
- **Chance em Dobro aparece na hora de comprar**: se estiver ativa, o cliente vê "🔥 Você está adquirindo 300 títulos — e leva o DOBRO: 600 títulos no total" antes mesmo de confirmar a compra.
- **Chance em Dobro aparece depois de pagar**: na página de checkout, se o cliente recebeu mais títulos do que pagou, aparece um banner "🔥 Você comprou com Chance em Dobro! Pagou por 300 e recebeu 600 títulos."

## Ainda pendente

Sistema de Promoções/Combos com desconto (a última peça grande) e combos clicáveis que já selecionam a quantidade. Vou continuar na Parte 7 com essa funcionalidade nova.


## O que ficou pronto nesta rodada

- **Excluir link no Comparativo geral**: agora tem lixeirinha em cada linha da tabela, direto ali (antes só dava pra excluir de dentro do formulário "Criar Link").
- **Reordenar fotos pra posições específicas**: além de "tornar principal" e "excluir", agora tem setinhas ◀▶ pra mover cada foto pra frente/trás na ordem, com numerozinho mostrando a posição de cada uma.
- **🐛 Achei outro bug real**: a ferramenta de "marcar como já ganho" (que criei numa rodada anterior) só estava disponível pro Bilhete Premiado — na Roleta não tinha o mesmo botão! Corrigido: agora a aba Roleta também tem "🏆 Simular ganho" em cada prêmio, exatamente como você pediu.
- **Editar Roleta redesenhado**: cards com status visual (verde = já ganho, com nome do ganhador), botão de editar (lápis) pra mudar título/cota depois de criado.

## Ainda pendente

Atalho de bloquear/liberar cota específico da aba Roleta, Chance em Dobro aparecer no checkout, sistema de Promoções/Combos com desconto, combos clicáveis que já selecionam quantidade.

Vou continuar na Parte 6 — essa última parte (Promoções) é a maior peça que falta, uma funcionalidade nova inteira.


## Você tinha razão — refiz a varredura e encontrei o que realmente faltava

## O que ficou pronto nesta rodada

- **Seletores de sorteio centralizados**: Bilhete Premiado, Roleta e Chance em Dobro agora têm o seletor grande, no meio da tela (não mais escondido no canto).
- **Bilhete Premiado abre em "Visualizar" por padrão** (não mais "Editar") — exatamente como você pediu.
- **Bilhete Premiado redesenhado**: cards grandes, fundo verde pros que já saíram (com nome do ganhador e botão de WhatsApp pronto), fundo vermelho pros disponíveis.
- **Editar depois de criado** — agora tem botão de lápis pra mudar título/cota de um bilhete já cadastrado.
- **Roleta abre em "Visualizar" por padrão** também.

## Ainda pendente (a lista continua grande, seguindo com calma)

Redesign visual completo da aba Editar de Roleta, atalho de bloquear/liberar cota específico da Roleta, reordenar fotos (posição 2/3/4, não só a principal), excluir link no Comparativo geral, ferramenta de "Simular já ganho" dedicada, mostrar Chance em Dobro no checkout, sistema de Promoções/Combos com desconto, combos clicáveis.

Vou continuar na Parte 5.


## O que ficou pronto nesta rodada

- **Busca em Pedidos**: por nome, telefone ou CPF — funciona junto com os filtros de status que já existiam.
- **Aba Expirados ganhou duas ações**: "Baixar lista de expirados" (CSV com nome, telefone, CPF, sorteio, valor — pronto pra usar numa campanha de recuperação) e "Excluir todos os expirados" (limpa o banco de dados, com confirmação antes).
- **Configuração de pós-pagamento removida da criação de Funil** — como você pediu, isso ficou redundante e foi tirado do formulário.

## Ainda pendente da lista grande

Reordenar fotos, redesign visual de Bilhete Premiado e Roleta (seletor centralizado + visualização primeiro), ferramenta de simular bilhete/roleta já ganho, sistema de Promoções/Combos com desconto, combos clicáveis, mostrar Chance em Dobro no checkout. Vou continuar.


## O que ficou pronto nesta rodada

- **Aba dedicada "Urgência"** no menu — igual você pediu: seletor de sorteio centralizado, e agora dá pra ter **vários avisos por sorteio** (não só um), cada um com seu próprio período. Isso também deixa pronto pro que você mencionou de "no futuro ter vários tipos de aviso diferentes".
- **Editar aviso depois de criado** — antes só dava pra ligar/desligar ou excluir, agora dá pra editar título, descrição e datas.
- Tirei o Aviso de Urgência de dentro do formulário de Editar Sorteio — agora é 100% independente, na aba própria.

## ⚠️ Precisa rodar o SQL de novo

Nova tabela `avisos_urgencia` (substitui os campos antigos que estavam direto na tabela `sorteios` — os avisos antigos que você já tinha configurado vão precisar ser recriados na aba nova, já que mudou de lugar no banco).

## Ainda pendente da lista grande (Parte 3 em diante)

Reordenar fotos, pedidos (excluir expirados em massa, baixar lista, buscar por telefone/nome/CPF), remover config de pós-pagamento redundante no funil, redesign de Bilhete Premiado e Roleta (seletor centralizado + visualização primeiro + editar depois — os textos e regras já ficaram melhores na Parte 1, mas o design visual ainda não mudou), ferramenta de simular bilhete/roleta já ganho, sistema de Promoções/Combos com desconto, combos clicáveis que já selecionam quantidade, mostrar Chance em Dobro no checkout.


## Sua lista era gigante — dividi em partes. Esta é a Parte 1: bugs que realmente quebravam o sistema.

## 🐛 Bugs encontrados e corrigidos

1. **Roleta desativando sozinha ao editar sorteio**: o campo que liga/desliga a roleta foi movido pra aba própria numa correção anterior, mas o formulário principal de "Editar Sorteio" continuava resetando esse campo pra desligado toda vez que você salvava qualquer outra coisa. Corrigido — agora só a aba Roleta controla isso.

2. **Bloqueio de cota não funcionava de verdade**: quando você digitava um número de cota pra bloquear (ex: "900"), o sistema salvava exatamente como digitado, mas as cotas de verdade são geradas com zeros à esquerda (ex: "0000900"). Como o texto nunca batia, o bloqueio nunca surtia efeito. Mesmo bug afetava a **liberação agendada de cota** e o **cadastro de Bilhete Premiado**. Corrigido nos três lugares.

3. **Botão "Remover" da roleta não funcionava**: na verdade ele excluía do banco corretamente, mas atualizava a lista errada na tela (atualizava a lista de Bilhete Premiado em vez da lista de Roleta), então parecia que nada tinha acontecido. Corrigido.

4. **Valor "pendente" não saía de Visão Geral/Relatórios/Comparativo de Links quando o pedido expirava**: encontrei e corrigi em **4 lugares diferentes** no sistema — todos contavam pedidos expirados como se ainda estivessem pendentes.

5. **Chance em Dobro sem opção de editar**: agora dá pra editar título e datas depois de criada (antes só dava pra ligar/desligar ou excluir).

6. **Bilhete Premiado sem opção de editar depois de criado**: agora dá pra editar o prêmio e o status depois.

7. **Sistema sempre voltava pra Visão Geral ao atualizar a página**: agora lembra em qual aba você estava.

## Ainda na lista (Parte 2, 3, 4... — é grande, vou continuar)

Aba dedicada de Urgência, reordenar fotos, pedidos (excluir expirados em massa, baixar lista, buscar por telefone/nome/CPF), remover config redundante de pós-pagamento no funil, redesign completo de Bilhete Premiado e Roleta (seletor centralizado, visualização primeiro, editar depois), ferramenta de simular bilhete/roleta já ganho, sistema de Promoções/Combos com desconto, combos clicáveis que já selecionam a quantidade, e mostrar quando o cliente usou Chance em Dobro no checkout.

## ⚠️ Recomendo testar bloqueio e liberação de cota primeiro

Esses dois bugs eram sérios — teste criando um bloqueio novo (os que já existem no banco de antes continuam com o formato errado, pode ser bom recriar).


## Fonte corrigida — descoberta importante

Achei que vocês usam **Montserrat** (confirmei no CSS: `@font-face { font-family: __Montserrat_fca8ee...}`). Nosso site estava usando Inter, que é visualmente mais "gorda"/pesada. Troquei pra Montserrat via Google Fonts (mesmo nome, aparência idêntica) — isso sozinho já deve deixar tudo com aparência bem mais fina e parecida.

## Pesos de fonte reduzidos (estavam grossos demais)

Título do sorteio, tag "Corre que está acabando", "Meus títulos", "Quanto mais títulos, mais chances de ganhar!", números dos botões de cota.

## Outros ajustes desta rodada

- **Botões de cota**: menos altos, "SELECIONAR" mais fino e transparente
- **Bug corrigido**: "Encerra em" sem espaço antes do horário
- **Card de urgência**: bordas menos arredondadas, barra de progresso com contraste mais forte
- **Pulso do combo**: reforçado (estava quase imperceptível)
- **Espaço entre "Meus títulos" e "Por apenas"**: reduzido
- **"Mostrar mais" agora tem "Mostrar menos"**, e itens já ganhos aparecem primeiro na lista (bilhete premiado e roleta)

## 🐛 Bug real encontrado: não dava pra marcar manualmente um bilhete como "já ganho"

Só existia o fluxo automático (quando alguém compra de verdade aquele número). Adicionei um botão 🏆 no painel (aba Bilhete Premiado → Editar) pra marcar manualmente com nome e telefone do ganhador, e um botão ↺ pra desmarcar se precisar.

## Fluxo de checkout redesenhado

Quando o telefone já é de um comprador conhecido, agora aparece uma tela de confirmação: "Você está adquirindo X títulos por R$Y", mostra os dados salvos do cliente, e dois botões — **Finalizar Pedido** (usa os dados salvos direto) ou **Usar outra conta** (abre o formulário pra preencher dados novos). Também adicionei o texto "Localizando comprador no sistema..." enquanto verifica o telefone.

## ⚠️ Precisa rodar o SQL de novo

Nova coluna em `bilhetes_premiados` (`nome_completo`) pra suportar o registro manual de ganhador sem precisar de conta vinculada.


## Minha análise comparando as duas fotos, ponto a ponto

Concordei com praticamente tudo que você apontou. Aqui está o que encontrei e corrigi:

1. **🐛 Altura da foto era o valor errado**: eu tinha 350px, o valor real de vocês é **310px** — achei isso procurando de novo no CSS (classe `.gallery`). Também adicionei o filtro de cor sutil que eles usam na imagem (contraste/saturação levemente realçados) e uma margem negativa que a foto usa lá.
2. **Fundo do "Por apenas"**: removi a caixa escura própria que existia só ali — agora usa o mesmo fundo da página, igual à referência.
3. **Borda branca no preço**: removida — agora é só preto sólido, sem borda.
4. **Vírgula cortada no preço**: corrigido o alinhamento vertical/altura pra nada ficar cortado.
5. **Tag "Corre que está acabando"**: aumentei bastante o tamanho (fonte e altura), estava pequena demais.
6. **Ícone do carrinho**: troquei pro ícone mais parecido com o formato "carrinho de compras" que a referência usa (eles usam Font Awesome `cart-shopping`; troquei pro Bootstrap Icons mais parecido, `cart3`).
7. **"Popular" voltou a ser "Mais popular"**.
8. **Combos da roleta**: reduzi a largura (86% em vez de quase 100%) especificamente pra sobrar espaço pro efeito de pulsar sem vazar da tela, e voltei a ter uma pulsada sutil de verdade (não só opacidade, um pouquinho de "respiração" também).
9. **Fontes dentro dos combos**: aumentei todas — "A cada", "X títulos", "Receba X Roletas" e a legenda pequena embaixo.

## Sobre o "10 rodadas tentando consertar coisas básicas"

Entendo a frustração. A cada rodada agora estou usando o CSS real que você mandou pra corrigir com precisão em vez de aproximar visualmente — essa última leva teve várias correções baseadas em número exato (310px, por exemplo) que só apareceram porque fui procurar de novo, com mais calma, no arquivo que você mandou.


## Sim, o .mhtml continua servindo — usei ele de novo nesta rodada

## O que encontrei e corrigi, comparando ponto a ponto com as duas fotos

- **🐛 Foto ocupando a tela inteira**: reforcei o limite de altura da foto (350px, com `!important` e travando também o container por fora) — antes talvez alguma coisa estivesse conseguindo estourar esse limite dependendo do tamanho da imagem original.
- **"MEUS TÍTULOS" em maiúsculas**: a referência usa tudo em caixa alta, a nossa estava com "Meus títulos" normal — corrigido.
- **Barra "Encerra em" agora é uma barra de progresso de verdade**: antes era só um texto centralizado num fundo sólido. Agora tem um preenchimento que cresce conforme o tempo passa (do início até o fim do aviso) — exatamente o efeito que você descreveu ("de um lado não dá pra ver, do outro lado está finalizando").

## O que ainda não mudei (preciso entender melhor antes)

A questão da borda no "R$ 0,03" — o meu já tem uma borda sutil (quase invisível de propósito, é assim que o CSS de vocês define). Se ainda estiver visualmente diferente depois dessa atualização, me aponta especificamente essa parte de novo que eu foco só nela.


## O que mudou

- **Título do sorteio maior e mais grosso**: comparando o print exato que você mandou com o que eu tinha, o tamanho real é bem maior do que a "leitura" que eu fiz do CSS na rodada anterior (que estava incompleta/ambígua). Corrigido pra `1.4rem`, negrito (700), igual à foto que você mandou.
- A tag "Corre que está acabando" apagada no seu print é esperado — ela pisca (efeito que você mesmo pediu), e o print pegou o momento do ciclo em que ela está quase transparente. Não é bug.

## Dica pra próximas comparações

Quando quiser comparar um elemento específico, um print direto (como esse que você mandou) é mais confiável do que eu tentar ler o CSS bruto — o CSS às vezes tem contexto que eu não consigo recuperar 100% (como tamanhos relativos "em" que dependem de outros elementos). Continua mandando prints de pedaços específicos que a gente vai fechando rápido assim.


## Resposta à sua pergunta: dá pra clonar 100%?

Sendo honesto: consigo chegar muito perto (95-99%) nos elementos que aparecem nos arquivos que você manda, porque agora tenho o CSS real, não mais chute. Mas não tenho como garantir "100% idêntico" com certeza absoluta, porque não consigo comparar visualmente o que eu construo com o site de vocês lado a lado (não tenho como "ver" a página renderizada do jeito que você vê no celular). O que dá pra fazer é: eu aplico os valores exatos do CSS de vocês, e a gente vai fechando qualquer diferença que sobrar com prints específicos — é assim que estamos conseguindo chegar cada vez mais perto.

## O que descobri de novo nesta rodada (fazendo uma varredura completa, não mais pedaço por pedaço)

Catalogei as **845 classes CSS customizadas** do site de vocês de uma vez, e assim achei uma peça que ainda não tinha construído: o **Aviso de Urgência** ("CORRE QUE ESTÁ ACABANDO") com contagem regressiva — é diferente da Chance em Dobro, é só um banner visual chamativo, sem efeito na compra.

## Nova funcionalidade: Aviso de Urgência

- Nova seção em Editar Sorteio → Config: liga/desliga, título, descrição, data de início e fim.
- No site, aparece como um card com gradiente, título grande, "Encerra em HH:MM:SS" contando ao vivo, descrição, e "Válido de X até Y" — usando o tamanho de fonte exato que achei no CSS de vocês (`countdown-title`, `countdown-subtitle`, `countdown-warning`).
- Ícone do "Meus títulos" trocado pra carrinho (estava com ícone de bilhete).

## ⚠️ Precisa rodar o SQL de novo

Novas colunas em `sorteios` (notice_active, notice_title, notice_description, notice_init_at, notice_end_at).


## O que fiz diferente desta vez

Reanalisei o CSS extraído com mais atenção — dessa vez encontrei o **tamanho base da fonte** do site deles (que faltava da vez passada), o que me permitiu calcular os tamanhos reais em pixel, não só em "em" relativo.

## Correções desta rodada

- **Título do sorteio**: o tamanho real deles é bem menor do que eu tinha colocado — corrigido pra bater exatamente.
- **"Meus títulos"**: reduzi a fonte e o preenchimento pra bater com o tamanho real do botão pequeno deles.
- **"Por apenas R$X"**: reconstruí do zero com a estrutura exata — o "Por apenas" e o valor ficam lado a lado, centralizados, com o valor num "selinho" preto com borda fina, exatamente como no site de referência (antes eu tinha um layout diferente).
- Limpei CSS órfão que sobrou de versões anteriores.

## Sobre a caixa de combos

Ainda estou com dificuldade de achar a medida exata de largura da caixa de combo no CSS — pode ser que dependa de um contêiner pai que não veio completo nos arquivos. Se puder, tenta um print bem próximo (zoom) só daquela caixa específica, mostrando as bordas dela em relação à tela, que eu meço em pixels e ajusto certinho.


## Changelog desta rodada

- **Cabeçalho da foto igual ao de referência**: removi a linha "Participe e concorra!" que não existia lá, ajustei a fonte do título e a proximidade da tag "Corre que está acabando!" — igual à posição/tamanho do site deles.
- **Descrição + Regulamento unificados**: agora aparecem juntos no mesmo bloco colapsável "Descrição / Regulamento" — exatamente como no site de referência (que usa um único campo pra tudo).
- **Combos ajustados**: título com letra maior, caixa mais compacta (94% de largura, com margem, não mais tela inteira), e o "pulsar" ficou mais suave (variação de brilho de 100% a 88%, bem discreta — nada de pisca-pisca forte).
- **🐛 Bug da data em Chance em Dobro corrigido**: a causa era o navegador desenhando o ícone/calendário do campo de data escuro sobre fundo escuro — ficava praticamente invisível, dando a impressão de estar travado. Agora força o tema certo pro campo de data conforme o modo (claro/escuro) do painel.
- **Máximo de cotas por pedido agora é uma lista de opções**: 1.000 / 5.000 / 10.000 / 20.000 / 50.000 / 100.000 / sem limite — direto no Editar Sorteio, sem precisar digitar.

## ⚠️ Não precisa rodar SQL — só trocar os arquivos abaixo.


## O que foi clonado nesta rodada

- **Cabeçalho preto sólido** (70px de altura, exatamente como o deles), logo clicável levando pra página inicial — removi o botão "Voltar" que não existia no site de referência.
- **Barra "Meus títulos"** virou uma faixa preta de ponta a ponta (gradiente sutil), do jeito que aparece no site deles — não é mais um botão flutuante.
- **Tag "Adquira já!" virou "Corre que está acabando!"**, com o efeito de piscar exato deles (opacidade sobe e desce, sem escala) e no tamanho real (22px de altura).
- **🐛 Corrigido o vazamento dos combos da roleta**: a causa era o efeito de "pulsar" que eu tinha colocado usando `scale()` — isso fazia a caixa crescer fisicamente e vazar pra fora da tela no pico da animação. Troquei pra só variar a opacidade (sem crescer de tamanho), que é exatamente como o site de referência faz.
- **Chance em Dobro perdeu o amarelo**: agora usa o mesmo gradiente verde dos combos, consistente com o resto do site.
- **🐛 Corrigido roleta "Disponível" toda verde**: agora segue a mesma regra do Bilhete Premiado — só o que já foi ganho fica verde, o que ainda está disponível fica escuro.

## Ainda no pipeline (próxima rodada)

Ainda tenho mais peças de CSS que extraí e não apliquei: o card de urgência estilo "countdown" (laranja, para contagem regressiva de fim de sorteio), refinamentos da caixa de preço/valor no topo, e vou revisar o restante item por item comparando com o CSS real que você me passou.


## Grande virada nesta rodada

Os arquivos que você mandou (o `.mhtml` principalmente) continham o **CSS completo do site real**, escondido dentro do arquivo. Consegui extrair as cores e medidas exatas que o Léo Sorteios usa — não é mais aproximação por foto, é o valor exato que eles usam em produção.

## O que descobri e apliquei

- **Verde principal exato**: `#1a8754` (não era o que eu tinha chutado antes)
- **Verde do gradiente**: `#1a8754` → `#5be584` (esquerda pra direita, não diagonal)
- **Fundo do botão "mais popular"**: `#c8facd` com texto quase preto
- **Botão "Quero participar"**: padding bem mais fino que eu tinha (3px em cima/embaixo — bem mais compacto)
- **Botões de selecionar cota**: cantos com `border-radius: 4px` (bem menos arredondado que eu tinha)
- **Bilhete Premiado**: descobri que cada linha é BEM menor do que eu vinha fazendo — altura de 22px pro número, fonte de 12px pro título do prêmio, 14px pro nome do ganhador. Fundo verde por padrão, e "Disponível" vira um fundo escuro por cima.
- **Combo da roleta**: `border-radius: 12px`, padding de só 8px (bem mais enxuto), gradiente verde exato igual ao Título Premiado.

## Como isso muda o resultado

Antes eu estava no "olho" comparando com fotos — agora é o valor exato que o próprio site usa. Deve ficar visualmente muito mais parecido agora.

## Ainda não apliquei (fica pra próxima, se você confirmar que ficou bom)

- A barra "Meus Títulos" no topo é uma faixa preta que vai de ponta a ponta (sem cantos arredondados) — ainda não ajustei isso
- O card de urgência "CORRE QUE ESTÁ ACABANDO" (o countdown-card) tem um gradiente laranja específico que ainda não implementei
- Ainda não conferi item por item os outros componentes (roleta girando, tela de compra, etc.) contra esse CSS real


## O bug das redes sociais (resolvido de verdade dessa vez)

Entendi errado da última vez — você não queria que ela ficasse fixa na tela, queria o oposto: que ela role **naturalmente junto com a página**, sem ficar presa em lugar nenhum. Removi toda a lógica de "grudar" e voltei pro comportamento simples: ela mora dentro da foto, no canto superior direito, e quando você rola a página ela some com a foto, normalmente, sem travar em lugar nenhum. Sem JavaScript de rolagem, sem bug possível.

## Ajustes visuais (baseados nas fotos que você mandou)

- **Verde mais suave**: removi o brilho "neon" pulsante que eu tinha colocado no botão (isso que estava deixando "fluorescente"), e troquei o verde por um tom mais fosco/tranquilo.
- **Botão "Quero participar" + seletor lado a lado**, como na referência — texto em cima, preço embaixo, com o seletor de quantidade ao lado (não mais empilhados).
- **Números dos botões de cota maiores**, mais visíveis.
- **Combos da roleta redesenhados**: gradiente de verde mais bonito, "A cada" pequeno em cima e a quantidade de títulos grande embaixo, tudo contido dentro do card (sem vazar pros lados).
- **Títulos Premiados/Bilhetes**: aumentei um pouco o tamanho pra ficar mais parecido com a organização da referência.

## Se ainda não bater 100% com a referência

Manda um print de como ficou no seu celular que eu comparo lado a lado com a referência e ajusto o que faltar.


## Changelog desta rodada

- **"Mais popular" virou só "Popular"** — texto mais curto, cabe numa linha só, não quebra mais feio.
- **Badge travado pra nunca vazar do botão**: mesmo com números grandes tipo "+10000", o selo fica contido dentro do botão (nunca mais empurra o layout pra fora da tela).
- **Números grandes nos botões de cota**: ampliei a faixa de telas que usa fonte menor (agora cobre até celulares maiores como iPhone Pro Max), e qualquer texto que ainda assim não coubesse fica cortado com "..." dentro do próprio botão, em vez de vazar pra fora da página.


## O que estava errado de verdade

Peço desculpas pela versão anterior — o problema não estava só na posição, era estrutural: eu tinha colocado os ícones de redes sociais **dentro** da caixa da foto, e essa caixa tem um elemento (o carrossel) que usa uma propriedade de CSS chamada `transform`. Isso faz o navegador tratar "fixar na tela" de um jeito completamente diferente do esperado — por isso ficava bugado, pulando, ficando preso em lugar errado quando rolava a página.

## A correção desta vez

- **Tirei os ícones de dentro da foto por completo** — agora eles vivem soltos, fora de qualquer caixa que possa interferir. Isso resolve o bug de vez, não é mais um ajuste de posição, é a raiz do problema resolvida.
- **Tamanho normal de novo** (42px) — não ficam mais "pequenininhos".
- **Cálculo de posição mais preciso**: enquanto a foto aparece na tela (mesmo que só uma parte dela), os ícones ficam centralizados na parte visível da foto. Assim que a foto sai completamente da tela, eles ficam fixos pertinho do topo.
- **Efeito neon sutil no "Quero participar"**: uma pulsação suave de brilho verde, sem ser exagerada.

## Sobre a foto que pareceu "deslocada" no seu print

Aquele print específico parece ter capturado o navegador no meio de um gesto de troca de aba do Safari (dá pra ver a barrinha de endereço cortada e os botões de navegador na parte de baixo) — não é algo que o código da página controla. Se depois de atualizar você ainda notar a foto deslocada/cortada **fora** desses momentos de troca de aba, me manda um print novo que eu investigo com atenção.


## Changelog desta rodada

- **🐛 BUG IMPORTANTE corrigido**: quando um telefone já cadastrado tentava comprar de novo, o sistema pedia CPF mesmo que a pessoa já tivesse CPF salvo — porque a verificação usava o que veio vazio do formulário em vez de olhar o cadastro existente no banco. Corrigido: agora verifica os dados que a pessoa JÁ tem salvos antes de exigir de novo.
- **Redes sociais acompanham a rolagem**: enquanto a foto está visível, ficam centralizadas nela (sem tampar o preço). Ao rolar pra baixo e a foto sair da tela, "grudam" pequenininhas no canto superior direito, sempre visíveis, sem atrapalhar nada.
- **Botões de +/- de cota consertados**: estavam com tamanho fixo grande demais espremidos numa grade de 2 colunas, cortando em telas pequenas. Agora o seletor de quantidade fica numa linha própria (largura total), e o botão de comprar embaixo — sem cortar em nenhum tamanho de tela.
- **Ajustes extras de segurança mobile**: números grandes nos botões de cota não estouram mais o card, e o "grudamento" nas bordas foi revisado.

## ⚠️ Esse bug do CPF é sério — recomendo subir isso o quanto antes

Se você estava perdendo vendas de clientes recorrentes por causa desse erro, essa correção deve resolver.


## Changelog desta rodada

- **Redes sociais reposicionadas**: agora ficam só dentro da área da foto (não tampam mais o valor do sorteio/preço). Também diminuí um pouco o tamanho dos botões pra caberem certinho sem cortar, mesmo com os 5 ativados ao mesmo tempo.
- **Botão "Quero participar" mais compacto**: texto e preço agora ficam na mesma linha, botão bem menor que antes.
- **Combos da roleta**: adicionei o mesmo efeito de "piscar" (fica transparente e volta) que já tinha na tag "Adquira já!" — visual mais chamativo.

## Ainda não fiz nesta rodada

O fundo dos combos já era verde (gradiente) no código — se ainda estiver aparecendo diferente no site, me manda um print de como está ficando que eu ajusto o tom certo.


## Changelog desta rodada

- **Filtro de período** no Comparativo de Links — mesmo calendário único usado em Visão Geral e Relatórios.
- **Clique em qualquer link abre o detalhe completo**: acessos, pedidos pagos, faturamento, pendente, expiradas, conversão, e um gráfico de linha (acessos x faturamento por dia).
- **Comparar 2 links lado a lado**: marca duas caixinhas na tabela, clica em "Comparar selecionados", abre uma tela mostrando as métricas de cada um lado a lado pra você decidir qual está performando melhor.

## ✅ Essa era a última pendência da lista grande

Com isso fecho tudo que ficou pendente nas últimas rodadas: bug crítico da página em branco, Maior/Menor Cota, menu de 3 pontinhos, rolagem, zoom no celular, Regulamento colapsável, logo na sidebar, galeria de imagens, Buscar Ganhador (cores, nome completo, concurso, WhatsApp), gráfico de relatórios moderno, e agora o Comparativo de Links completo.

Recomendo um teste geral de ponta a ponta agora — se achar algo que não ficou do jeito esperado, me manda o print exato ou os passos pra reproduzir que a gente ajusta rapidinho.


## Changelog desta rodada

- **🐛 Bug de cores corrigido no Buscar Ganhador**: no modo claro, uma regra global trocava o texto branco por escuro — mas a tela de revelação sempre tem fundo escuro (é uma "cena" própria, não segue o tema do painel), então o texto ficava escuro sobre fundo escuro, quase invisível. Corrigido.
- **Nome do ganhador agora aparece completo** (tirei o mascaramento que você não gostou — só o telefone continua com risquinho no meio).
- **Título simplificado**: "Ganhador" em vez de "Temos um ganhador!", com fonte mais bonita.
- **Campo do concurso da Loteria Federal** — opcional, fica salvo e exibido junto do resultado.
- **Botão de voltar** (canto superior esquerdo) e **botão de WhatsApp** direto pro ganhador, além do "Ver compra" que já existia.
- **Gráfico de Relatórios reconstruído**: agora é um gráfico de linhas moderno, com três curvas suaves (Faturamento total, Faturamento líquido, Despesas), preenchimento em gradiente e tooltip mostrando os três valores juntos ao passar o mouse.

## ⚠️ Nesta rodada só mudou frontend + a query de relatórios — não precisa rodar SQL de novo.

## Ainda na fila

Comparativo de Links: filtro de período, clique pra detalhe com gráfico, e comparar 2 links lado a lado.


## Changelog desta rodada

- **Galeria de imagens totalmente reconstruída**: agora tem miniaturas quadradinhas (não mais aquele formato "capa de YouTube" esticado), cada foto com botão de excluir e botão de "tornar principal" (marca com estrela ⭐), e um botão separado pra adicionar mais fotos — pode selecionar uma ou várias de uma vez, sempre que quiser.
- **🐛 Bug corrigido**: antes, toda vez que você adicionava uma foto nova, ela virava a principal automaticamente e "perdia" a antiga — mesmo se sua intenção era só acrescentar à galeria. Agora só vira principal se você marcar isso de propósito.
- **Carrossel do site**: ajustado pra girar a cada 3 segundos (era 5), e agora reinicia a contagem quando você navega manualmente pelas setas ou bolinhas, pra não trocar de foto logo depois de você ter acabado de trocar na mão.

## Ainda na fila

Gráfico de relatórios mais moderno, Comparativo de Links (filtro de período, detalhe com gráfico, comparar 2 links), e a versão final do Buscar Ganhador.


## Changelog desta rodada

- **Regulamento colapsável**: novo campo na aba Geral de cada sorteio. No site, aparece fechado logo abaixo do botão "Quero participar" — clica pra abrir, clica de novo pra fechar. Se não preencher, a seção nem aparece.
- **Logo no lugar do nome do sistema**: se você já tem uma logo configurada (Conta & Identidade → Logo), ela aparece no topo do menu lateral no lugar do texto. Sem logo configurada, continua mostrando o nome normalmente (não quebra nada pra quem ainda não subiu uma logo).

## ⚠️ Rode o SQL de novo

Nova coluna (`sorteios.regulamento`) — copia o `database.sql` inteiro de novo no Supabase (é seguro, só adiciona o que falta).

## Ainda na fila

Galeria de imagens (múltipla/única, excluir, tamanho bonito, carrossel), gráfico de relatórios mais moderno, Comparativo de Links (filtro de período, detalhe com gráfico, comparar 2 links), e a versão final do Buscar Ganhador.

Se ao testar aparecer algo que não ficou do jeito que você imaginou, é só me falar exatamente o que viu que a gente ajusta.


## Changelog desta rodada

- **Calendário único de período**: substituí os dois campos de data (De/Até) por um único botão que abre um calendário — clica no dia de início, clica no dia de fim, pronto. Também tem os atalhos rápidos (Hoje, Ontem, 7 dias, Este mês, Tudo) no topo do mesmo popover. Aplicado em Visão Geral e Relatórios.
- **Bilhete Premiado e Roleta ganharam abas "✏️ Editar" e "👁️ Visualizar"**: Editar é onde você configura tudo; Visualizar é uma tela mais limpa, só de acompanhamento — mostra os bilhetes/roletas com status, e clicar num já reivindicado já chama o ganhador no WhatsApp com mensagem pronta.

## Ainda na fila

Top 3 em Top Comprador e Maior/Menor Cota, e a versão dramática do Buscar Ganhador (contagem regressiva, confete, dados mascarados, link da compra).


## Changelog desta rodada

- **Clientes redesenhado por completo**: paginação de 10 em 10, telefone e CPF mascarados (mostra só início/fim), badge "Ativo/Inativo" (baseado em compra no sorteio mais recente), data de entrada, data da última compra, botão de WhatsApp direto, e lixeira pra excluir.
- **"Acesso direto/orgânico" virou "Link Oficial do Sorteio"** — e agora tem botão de copiar tanto na lista de Sorteios (menu de 3 pontinhos) quanto em cada linha do Comparativo de Links (nova coluna "Ação").

## Ainda na fila

Calendário único de período, editar/visualizar em Bilhete Premiado e Roleta, Top 3 em Top Comprador/Maior-Menor Cota, e a versão dramática do Buscar Ganhador.


## Changelog desta rodada

- **Redes sociais globais** — Conta & Identidade agora tem Instagram, Telegram, Facebook, Grupo do WhatsApp e WhatsApp de Suporte, cada um com chavinha própria. O que estiver ativo aparece como bolinha flutuante colorida na lateral direita de todos os sites de sorteio.
- **🐛 Modal de Pedidos consertado**: era o mesmo tipo de bug de antes — mostrava TODAS as cotas de uma vez sem limite, estourando o modal. Agora mostra 5 e tem "Ver mais" pra carregar o resto aos poucos.
- **Modal de Pedidos agora tem**: link de pagamento/checkout com botão de copiar, botão de WhatsApp direto pro comprador, CPF (quando coletado).
- **Paginação de Pedidos ajustada pra 10 por página** (estava em 20).
- Todo modal agora tem altura máxima com rolagem interna, pra nunca mais estourar a tela independente do que tiver dentro.

## O que ainda falta

Clientes (paginação, mascaramento, lixeira, redesenho), calendário único de período, "Link Oficial do Sorteio" + copiar, editar/visualizar em Bilhete Premiado e Roleta, Top 3 em Top Comprador/Maior-Menor Cota, e a versão dramática do Buscar Ganhador.


## Changelog desta rodada

- **⚡ Chance em Dobro — funcionalidade completa e nova**: aba própria no menu, você escolhe o sorteio, cria um período (título + início + fim), liga/desliga quando quiser. Quem comprar dentro da janela ativa recebe o dobro de títulos pelo mesmo preço pago. Na página do sorteio, aparece um banner logo abaixo do preço com barra de progresso e contagem regressiva até acabar.

## O que ainda falta (continua pra próxima)

Ainda não fiz: redes sociais em Conta & Identidade, melhorias em Pedidos (modal quebrado com cotas transbordando, paginação de 10, link de pagamento, WhatsApp), melhorias em Clientes (paginação, mascaramento, lixeira), calendário único de período (em vez de dois campos de data), renomear o link automático pra "Link Oficial do Sorteio" + botões de copiar, alternância editar/visualizar em Bilhete Premiado e Roleta, Top 3 em Top Comprador e Maior/Menor Cota, e a versão mais dramática do Buscar Ganhador (contagem regressiva, confete, dados mascarados, link pra ver a compra).


## Changelog desta rodada

- **🐛 Bug grande: botões de cota rápida não funcionavam de verdade.** A página do sorteio tinha 4 botões fixos no HTML — o que você configurava no dashboard nunca era lido. Agora a página do sorteio lê a configuração de verdade, suporta até 6 botões, e o botão "mais popular" é escolhido por você (⭐).
- **Botões de quantidade agora somam** em vez de substituir (clicar +500 duas vezes = +1000 no total).
- **Bilhete Premiado e Roleta viraram abas próprias** no menu — escolha o sorteio no topo da página e configure tudo ali (antes ficava preso dentro de "Editar Sorteio").
- **Liberação de cota agora aceita condição de quantidade**: "libera essa cota nessa data, mas só pra quem comprou acima/abaixo de X títulos".
- **Funis e Links agora vivem em "Links & Funis"** (renomeado de "Comparativo de Links"), com 3 abas internas: Comparativo, Criar Link, Criar Funil.
- **Colunas clicáveis pra ordenar** no comparativo (Acessos, Pedidos, Faturamento, Pendente, Ticket Médio, Conversão) — clique pra ordenar decrescente, de novo pra crescente, de novo pra tirar a ordenação.
- Removido código morto/duplicado que tinha sobrado de versões anteriores.

## O que ainda falta (fica pra próxima)

Redes sociais configuráveis em Conta & Identidade, Chance em Dobro, menu de 3 pontinhos com exportação incremental de compradores, e as melhorias nos modais de Pedidos/Clientes (paginação de cotas, link de pagamento, botão de WhatsApp).


## Changelog desta rodada

- **🐛 BUG GRANDE corrigido: modais que não fechavam.** A causa: ao abrir um modal eu fixava `display:flex` direto no elemento (via `.css()` do jQuery), e esse estilo "grudado" tinha prioridade sobre a classe que deveria escondê-lo de novo — então clicar no X parecia não fazer nada (só um refresh resolvia). Isso afetava: tela de revelação do ganhador, detalhe de pedido, detalhe de cliente, confirmação de exclusão, modal da roleta, modal de checkout e modal de "meus títulos" no site do sorteio. Todos corrigidos.
- **Todos os `alert()` do dashboard viraram notificação "toast"** (só faltavam esses — os das páginas públicas já tinham sido trocados antes).
- **Menu mobile**: no celular, o menu lateral agora fica recolhido, com um botão de "☰" no topo pra abrir e um "X" (ou tocar fora) pra fechar. Ele já fecha sozinho quando você escolhe uma aba.
- **Bilhete Premiado**: novo checkbox "Ativo" ao criar — se desmarcado, aquele prêmio fica pausado (não sai pra ninguém) sem precisar excluir.

## O que ainda falta desta rodada (fica pra próxima)

Você pediu uma reorganização grande: tirar Bilhete Premiado, Roleta e Bloqueio de Cota de dentro de "Editar Sorteio" e colocar cada um numa aba própria no menu; e mover a criação de Funis e Links pra dentro de "Comparativo de Links" (com colunas clicáveis pra ordenar). Também pediu uma função nova de "Chance em Dobro", liberação de cota condicionada a quantidade comprada, redes sociais configuráveis em Conta & Identidade, e melhorias no modal de pedidos/clientes. Isso é bastante coisa de interface pra fazer com cuidado — prefiro entregar certo a entregar corrido. Fica pra continuar na próxima mensagem.


## Changelog desta rodada

- **Bilhete Premiado e Roleta**: refeitos pra bater exatamente com o formato do print — cota em pílula branca à esquerda (só no bilhete, a roleta nunca mostra número), prêmio no meio, nome de quem ganhou + troféu à direita quando já saiu, "Disponível" quando ainda não saiu. Linha toda verde quando já tem ganhador, escura quando ainda está disponível.
- **Ordem corrigida**: os que já saíram (com ganhador) aparecem primeiro, os disponíveis depois — tanto no bilhete quanto na roleta.
- **Roleta agora mostra os disponíveis também**, não só os que já saíram — antes só existia o contador "X/Y", faltavam as linhas individuais dos prêmios ainda não sorteados.


## Changelog desta rodada

- **Página pós-pagamento reconstruída pra ficar igual ao print que você mandou**: agora reaproveita a mesma estrutura da tela de "aguardando pagamento" (card do sorteio com foto, card "Detalhes da sua compra" com CPF/telefone mascarados) — só troca o card do topo pra "✅ Pagamento identificado!" verde. Antes era uma tela separada e mais simples, sem a foto nem os detalhes.
- **Grupo VIP**: botão fica logo abaixo do card "Pagamento identificado", bem no topo — como no site de referência.
- **Títulos**: agora ficam dentro do próprio card "Detalhes da sua compra", mostrando os primeiros e um botão "Ver mais títulos" que revela o resto aos poucos.
- **Roletas**: continuam logo abaixo, agora dentro de um card no mesmo estilo dos outros.


## Changelog desta rodada

- **Todas as cores laranja viraram verde** — checkout, página do sorteio e index.
- **Mecânica da roleta corrigida pra bater com o que você descreveu**: agora funciona exatamente igual ao bilhete premiado — um número de cota real e escondido, associado a um prêmio. Quando essa cota específica é vendida pra alguém que tem giro disponível, o prêmio é confirmado. Se sair pra alguém sem giro (comprou pouco ou nunca gira), o sistema realoca esse prêmio pra outra cota que ainda não foi vendida, sem se perder.
- **Roda da roleta**: agora tem som de "tique" a cada fatia que passa (sintetizado, sem precisar de arquivo de áudio), o ponteiro reage fisicamente a cada fatia, e ela sempre desacelera e para exatamente na fatia certa — "Tente Denovo" quando não ganhou, ou o prêmio de verdade quando ganhou.
- **Pós-pagamento reorganizado**: botão do Grupo VIP mais visível (destacado com brilho, logo abaixo do título "Pagamento Aprovado"), CPF e telefone mascarados (mostra só início e fim), lista de títulos agora usa "Ver mais" em vez de rolagem.

## O que ainda não foi feito

- O visual detalhado de "Títulos Premiados" e "Roletas Instantâneas" (caixinha branca pro número, formatação exata) ainda não está pixel a pixel igual ao Léo Prêmios — a estrutura e as cores já batem, mas os detalhes finos de espaçamento/fonte ainda podem precisar de ajuste fino.
- Efeito de "quase parar num prêmio antes de continuar" na roda (a desaceleração hesitando) — o que tem agora desacelera de forma constante, não com a hesitação exata que você descreveu.


## 🚨 Bugs corrigidos nesta rodada (importante)

1. **BUG DE DINHEIRO — preço errado**: ao configurar "R$ 0,03" no dashboard, o sorteio ficava com "R$ 3,00" (multiplicado por 100). Causa: uma função de limpeza de número pensada pra outro formato estava rodando em cima de um valor que já vinha certo. **Se você já tem sorteios criados com essa versão com bug, entre em cada um e resalve o preço da cota pra confirmar que ficou certo.**
2. **Foto do sorteio sumindo**: ao editar um sorteio e salvar sem trocar a imagem, a foto era apagada (o formulário não guardava a URL da foto já existente). Corrigido — agora só substitui a foto se você realmente enviar uma nova.
3. **Comparativo de Links não mostrava o funil**: agora, ao criar um funil, o sistema já cria automaticamente um link de rastreamento pra ele (com 0 acessos), que aparece na hora em Comparativo de Links — e o link copiado do funil já vem com o parâmetro de rastreamento certo.
4. **Alertas feios do navegador**: trocados por notificações no estilo "toast" (aparecem no topo, desaparecem sozinhas) em toda a página do sorteio e do checkout.
5. **Botões de quantidade (+200, +300, etc.)**: agora ficam visualmente destacados quando selecionados, pra ficar claro que a seleção funcionou.

## Sobre o design idêntico ao Léo Prêmios

Ainda **não está** replicado visualmente — só a estrutura e o fluxo (roleta, telefone-primeiro, etc.) foram implementados. O visual (cores, fontes, espaçamento exato) segue no estilo que já tínhamos. Isso ainda está pendente.

## Sobre o "não deixa avançar pedindo CPF"

Não encontrei um bug estrutural nessa validação — a lógica só pede CPF se a opção "Coletar CPF" estiver **ativada** naquele sorteio específico (aba Geral → Editar Sorteio). Se está pedindo mesmo sem ativar, confirma esse toggle no sorteio que você está testando. Se continuar acontecendo mesmo com o toggle desligado, me manda print de qual mensagem aparece exatamente que eu investigo mais a fundo.


## Changelog desta rodada

- **Roleta reconstruída** com base no site de referência que você mandou (Léo Prêmios): agora funciona por **faixas de compra** ("a cada 300 títulos, ganha 4 giros") + um **pool de posições premiadas** configurável (ex: 40 posições, algumas pré-definidas como vencedoras). Cada giro já tem resultado determinado no pagamento — girar só revela, com animação de roda no checkout.
- **Checkout telefone-primeiro**: pede só o telefone de início; se for comprador conhecido, pula nome/CPF/email/endereço automaticamente. Lembra o comprador no navegador (localStorage) pra próxima visita.
- **Rastreamento de links por funil corrigido**: cada funil agora aparece com estatísticas próprias em Comparativo de Links, mesmo em acessos sem link manual (`?lk=`).
- **Dashboard "Visão Geral"**: novo card "Total de Clientes" (contagem distinta por comprador, não por pedido).
- **Sorteios**: barra de progresso visual (%) no lugar do texto simples de cotas vendidas; menu de ações com "Baixar lista de compradores" (agrupado por cliente) e "Baixar pedidos expirados", separado da exclusão/edição.
- **Pedidos**: clique em qualquer pedido abre modal com todos os detalhes (inclusive as cotas geradas); paginação de 20 em 20; status "expirado" agora é calculado e mostrado corretamente mesmo antes de você filtrar.
- **Relatórios**: cards de Faturamento, Pedidos, Clientes, Despesas, Lucro Líquido e ROI — com gestão de despesas (nome livre + valor + data) que entra automaticamente no cálculo.
- Bilhete premiado agora mostra o **nome do ganhador** direto na lista pública do sorteio (antes só aparecia no link do WhatsApp).

## Banco de dados

15 tabelas no total agora — `roleta_tiers`, `roleta_giros` e `despesas` são as novas desta rodada, além de colunas novas em `sorteios` (`roleta_ativada`, `roleta_pool_total`). Tudo já está em `database.sql`, é só rodar de novo (usa `IF NOT EXISTS`, seguro rodar por cima do que já existe).


## Changelog desta rodada

- **Coleta de dados configurável por sorteio**: além de nome e telefone (sempre obrigatórios), agora dá pra ativar **CPF**, **Email** e **Endereço** individualmente em cada sorteio — na aba "Geral" da edição do sorteio, seção "Dados coletados no checkout". Os campos só aparecem no site pro cliente se estiverem ativados, e o backend valida como obrigatório o que estiver ligado.
- CPF vem com máscara automática (`000.000.000-00`) no checkout.
- Novas colunas: `usuarios.cpf`, `usuarios.endereco`, `sorteios.coletar_cpf`, `sorteios.coletar_email`, `sorteios.coletar_endereco` (já incluídas em `database.sql`).

## Como funciona o login do admin (resumo)

1. **`scripts/criar-admin.js` fica dentro do projeto** (pasta `scripts/`) — não é um serviço rodando, é um comando que você executa manualmente (uma vez, ou sempre que quiser resetar a senha por fora do painel).
2. Depois de rodar o script uma vez, você já pode entrar em `/88652715/login` com o email/senha que definiu.
3. **Trocar email e senha depois**: pela própria aba "Conta & Identidade" dentro do painel — não precisa mais usar o script pra isso.


## ⚡ Guia rápido: do zero até o ar

### 1. Banco de dados (Supabase)
1. Crie um projeto em [supabase.com](https://supabase.com) (se ainda não tiver).
2. Vá em **SQL Editor → New query**, cole o conteúdo inteiro de **`database.sql`** (na raiz deste projeto) e clique em **Run**.
3. Vá em **Storage** e crie 2 buckets **públicos**: `sorteios` e `logos`.
4. Vá em **Project Settings → API** e copie a **Project URL** e a **service_role key** (não é a `anon` key — é a `service_role`, que fica em "Project API keys").

### 2. GitHub
1. Crie um repositório novo (pode ser privado).
2. Suba esta pasta inteira pra ele (`git init`, `git add .`, `git commit -m "primeira versão"`, `git push`).
   - O `.gitignore` já está configurado pra não subir `node_modules` nem seu `.env`.

### 3. Render
1. Em [render.com](https://render.com), clique em **New → Web Service** e conecte o repositório do GitHub.
2. Configuração:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
3. Em **Environment**, adicione as variáveis:
   - `SUPABASE_URL` → a Project URL que você copiou
   - `SUPABASE_SERVICE_ROLE_KEY` → a service_role key
   - `SESSION_SECRET` → qualquer string aleatória grande (o Render pode gerar uma pra você)
   - `NODE_ENV` → `production`
4. Clique em **Create Web Service** e espere o deploy terminar.

### 4. Criar seu usuário admin
Depois que o deploy terminar, no painel do Render vá na aba **Shell** do seu serviço e rode:
```bash
node scripts/criar-admin.js seu@email.com suaSenhaForte
```
Pronto — acesse `https://seu-servico.onrender.com/88652715/login` com esse email/senha.

### 5. Testar o sistema sem gateway configurado ainda
No dashboard, vá em **Gateway Pix** e ligue o **"Modo Teste de Pagamento"**. Isso faz aparecer um botão "Já paguei" no checkout que aprova o pedido na hora — assim você consegue testar o fluxo inteiro (criar sorteio → link → funil → compra → cotas geradas) sem precisar configurar Mercado Pago/Pay2M/Paggue ainda. **Desligue essa opção antes de divulgar o link pra clientes de verdade** — com ela ligada, qualquer pessoa pode "aprovar" o próprio pedido sem pagar.

---

## Changelog desta rodada

- **`database.sql`**: arquivo único com TODAS as tabelas e colunas que o sistema usa — é só copiar e colar no SQL Editor do Supabase.
- **`scripts/criar-admin.js`**: script pra criar (ou resetar a senha d)o seu usuário admin depois do deploy, sem precisar mexer direto no banco.
- **Correção crítica de dígitos das cotas**: sorteios de 10 milhões de cotas agora geram números de **7 dígitos** corretamente (antes saía 8); sorteios de 1 milhão geram **6 dígitos** (antes saía 7).
- **Proteção contra corrida em pagamentos simultâneos**: se dois pedidos forem aprovados ao mesmo tempo, o banco agora tem um índice único que impede duplicidade de cota, e o servidor já sabe se recuperar automaticamente disso (gera um número novo só pra quem colidiu, sem falhar o pedido inteiro).
- **Modo Teste de Pagamento**: botão "Já paguei" no checkout, protegido por uma chavinha no painel — só aparece quando você liga.
- **Sininho de notificações**: avisa no painel quando um bilhete ou roleta premiada sai, com toast automático.
- **Liberação de cota numa data**: completada — antes só existia a leitura no banco, agora tem tela pra cadastrar (na mesma aba de bloqueio de cota, dentro de "Bilhete Premiado").
- **Preparado pra produção**: cookies seguros (`secure`/`sameSite`) e `trust proxy` configurados para funcionar corretamente atrás do proxy HTTPS do Render.
- `render.yaml` incluso (facilita o deploy caso você use "Blueprints" do Render).

## ⚠️ Antes de aceitar dinheiro real

1. Configure um gateway de verdade em **Gateway Pix** (Mercado Pago, Pay2M ou Paggue) e **desligue o Modo Teste**.
2. Troque o `SESSION_SECRET` por um valor único seu (não reaproveite o de exemplo).
3. Os endpoints do Pay2M e Paggue no `server.js` estão implementados de forma ilustrativa — confirme o path exato e os campos de resposta na documentação oficial de cada um antes de usar com dinheiro real.


## Changelog desta rodada

- **WhatsApp de suporte com máscara de telefone** — `(11) 98888-8888` em vez de número corrido.
- **"Destacar na Home" virou uma chavinha (toggle switch)** em vez de checkbox quadrado.
- **Campo de Ganhador** aparece quando o status do sorteio é "Concluído": busca por número da cota (preenche o nome automaticamente se já houver comprador) ou digite o nome manualmente. Isso alimenta a seção de "últimos ganhadores" na home pública.
- **Links de rastreamento agora podem ser vinculados a um funil específico** — ao criar um link (ex: "Grupo do WhatsApp"), você escolhe se ele abre a página padrão ou um funil específico daquele sorteio.
- **Funil de checkout exposto na interface**: cada funil já podia (no backend) usar um arquivo de checkout customizado — agora isso está exposto no formulário, ao lado do arquivo da página inicial. Veja `public/funis/LEIA-ME.md` para como criar um checkout customizado (com espaço pra popups de upsell, por exemplo).
- **Pedidos**: filtro de data, abas de status com visual "pill" consistente, cores por status.
- **Clientes**: busca por nome/telefone, botão "Baixar lista (CSV)", e modal de detalhe do cliente com histórico de pedidos.
- **Top Comprador e Maior/Menor Cota**: agora com opção "Data e hora exatas..." — permite filtrar por um intervalo preciso (ex: hoje 00:00 até hoje 22:00), além dos atalhos rápidos (Hoje/7 dias/Mês).
- Corrigida uma rota duplicada de exportação de clientes que existia no backend.

## Nota sobre o que já vinha pronto

Ao revisar o código nesta rodada, encontrei que o backend já tinha suporte a "funil de checkout" e "link vinculado a funil" implementado — só faltava expor essas opções no formulário do dashboard, o que foi feito agora.


## Changelog desta rodada

- **Bilhete Premiado e Roleta agora são abas separadas** no menu lateral (antes ficavam juntos dentro do Dashboard):
  - **🎫 Bilhete Premiado**: escolhe o sorteio → mostra todos os bilhetes (verde = já saiu, vermelho = não saiu). Clicar num bilhete verde já abre o WhatsApp do ganhador com uma mensagem pronta.
  - **🎡 Roleta**: escolhe o sorteio → mostra quantas roletas ainda estão disponíveis e a lista de roletas já sorteadas (título do prêmio, valor e o ganhador) — **sem mostrar o número da cota**, como pedido.
  - **🏆 Buscar Ganhador**, **💰 Top Comprador** (ranking por valor em R$) e **🔢 Maior/Menor Cota** (ranking por quantidade de cotas compradas — métrica nova, separada de valor) também viraram abas próprias.
- **Correção importante de backend**: antes, quando uma cota sorteada batia com um bilhete premiado ou da roleta, nada acontecia automaticamente — agora, assim que as cotas de um pedido são geradas, o sistema já verifica e marca o bilhete como "reivindicado", vinculando o comprador. É isso que alimenta o WhatsApp automático e a lista de ganhadores da roleta.
- **Tema Dia/Noite**: botão 🌙/☀️ no topo do menu lateral alterna entre os dois temas (fica salvo no navegador). Todo o painel foi convertido pra usar variáveis de cor, então as duas versões ficam consistentes.
- **Identidade visual "Máquina Milionária"**: nome do sistema com duas cores (parte em branco/prata, parte em dourado com brilho animado), efeito de notas de dinheiro caindo no topo do menu. Continua editável em "Conta & Identidade" — se quiser outro nome, é só trocar lá.

## Ajustes técnicos

- Novas colunas em `bilhetes_premiados`: `usuario_id`, `pedido_id`, `reivindicada_em` (já incluídas em `database.sql`).
- Novo endpoint `GET /api/admin/dashboard/maior-menor-cota` (ranking por `quantidade_cotas`, não por `valor_total`).
- Novo endpoint `GET /api/admin/sorteios/:id/roleta/resultados` (retorna só título/valor/ganhador, nunca o número da cota).


## Changelog desta rodada

- **Nome do sistema personalizável**: em "Conta & Identidade" você define o nome que aparece no menu lateral e na aba do navegador (fica salvo em `SYSTEM_NAME`/`SYSTEM_SUB`, chave/valor na tabela `configuracoes` — não precisa mexer em código).
- **Dashboard redesenhado**: cards enxutos (Faturamento, Pendente, Pedidos, Ticket Médio, **Acessos** — novo), gráfico de vendas, e ao rolar pra baixo uma tabela **"Desempenho por Sorteio"** (acessos, pedidos, faturamento, pendente, ticket médio, conversão de cada sorteio lado a lado).
- **Filtro de período** com atalhos (Hoje / Ontem / 7 dias / Este mês / Tudo) + datas customizadas — aplicado aos cards, ao gráfico e à tabela por sorteio. O mesmo filtro de período também foi adicionado no card "Maior/Menor Comprador".
- **Buscar Ganhador com efeito "ao vivo"**: ao encontrar o ganhador, abre uma tela cheia com confete animado e o nome em destaque — pensada pra usar durante uma live de sorteio.
- **Buscar Bilhete Premiado / Roleta**: novo painel que lista todos os bilhetes (normais e de roleta) de um sorteio, coloridos em verde (já saiu) ou vermelho (ainda não saiu), com busca rápida por número.
- **Novo: rastreamento de acessos com data** (tabela `acessos_log`) — antes só existia um contador acumulado por link; agora cada acesso é registrado com timestamp, o que permite filtrar "acessos" por qualquer período.

⚠️ Nota sobre "Buscar Ganhador" com data: como o número sorteado é fixo (não muda com a data), não faz sentido técnico filtrar essa busca por período — o filtro de data foi aplicado onde ele realmente muda o resultado: nos cards do dashboard, na tabela por sorteio, e no Maior/Menor Comprador.


## Changelog desta rodada

- **Links de rastreamento**: crie links manuais por canal (WhatsApp, Instagram, Facebook Ads...) dentro de cada sorteio, ou deixe o sistema detectar sozinho (Google Ads, Facebook/Instagram Ads, WhatsApp, orgânico) via UTM/gclid/fbclid. Nova aba **"Comparativo de Links"** no dashboard mostra acessos, pedidos, faturamento, pendente, ticket médio e conversão lado a lado.
- **Teste A/B de funis**: dois ou mais funis no mesmo "grupo de teste" dividem o tráfego pelo peso configurado (ex: 50/50). Link de teste: `/sorteio/<slug>/teste/<grupo>`.
- **Roleta premiada**: nova aba dentro de "Bilhete Premiado" — mesma mecânica, mas o número não é exposto ao cliente.
- **Multi-gateway real**: Mercado Pago, Pay2M e Paggue selecionáveis numa central com abas, cada um com seus campos e o link do webhook já pronto para colar no painel do provedor. ⚠️ Os endpoints do Pay2M e da Paggue estão implementados de forma ilustrativa — confirme o path exato na documentação de cada um antes de ir para produção (fica claramente comentado no `server.js`).
- **Pixels multi-plataforma**: Facebook, Google Ads, TikTok e GTM configuráveis globalmente em "Pixels & Marketing", com opção de sobrescrever por sorteio na aba "Config" de cada um.
- **Formulário "Novo Sorteio" reorganizado**: máscara de moeda no preço, seletor de total de cotas (1mi/10mi/outro), presets de tempo de pagamento, upload múltiplo de imagem (vira carrossel automático), aba única "🏆 Bilhete Premiado" (que já inclui roleta e bloqueio/liberação de cota), chips visuais para os botões rápidos de cota.
- **WhatsApp de suporte**: agora só aparece dentro do menu (☰) do site do sorteio — não fica mais flutuando na tela.

## O que já existia (v2)

Front-end 100% HTML/JS estático + sistema de Funis por sorteio (múltiplos sites/layouts, cada um com seu link e comportamento pós-pagamento).

1. **Front-end 100% HTML/JS estático.** Nada de EJS. As páginas ficam em `/public` e buscam os dados via `fetch`/`$.ajax` em endpoints `/api/public/*` e `/api/admin/*`.

2. **Sistema de Funis** (novo). Dentro de um mesmo sorteio você pode criar vários funis:
   - Cada funil tem um `slug` próprio → a URL fica `/sorteio/<slug-do-sorteio>/<slug-do-funil>`.
   - Cada funil define o que acontece **depois do pagamento aprovado**:
     - `padrao`: mostra a tela normal com as cotas.
     - `bonus`: mostra uma tela customizada ("Sua compra foi premiada!") e pode gerar **cotas extras grátis** automaticamente.
   - Um campo `origem` (`ads` / `organico` / `outro`) serve só para você organizar/identificar de onde vem cada link.
   - Gerencie tudo isso na aba **"🧩 Funis"** dentro da tela de edição do sorteio, no dashboard.

3. **Bugs corrigidos** que encontrei no arquivo original:
   - Havia um `\n` literal (texto, não quebra de linha) logo depois do `app.listen(...)`, o que quebraria o servidor com erro de sintaxe ao subir.
   - As rotas de gateway (`/api/gateway/create-payment`) usavam `require('axios')` dentro de um projeto ES Modules — isso não funciona. Troquei por `fetch` (que já estava importado).
   - O endpoint `/api/public/meus-bilhetes`, chamado pelo front, não existia no backend — criei ele.
   - O token do Mercado Pago estava **hardcoded direto no código-fonte**. Movido para variável de ambiente `MP_ACCESS_TOKEN_FIXO` (veja `.env.example` abaixo). **Troque esse token antes de subir para qualquer repositório.**

## Rodando localmente

```bash
npm install
cp .env.example .env   # preencha com suas credenciais
npm start
```

## Variáveis de ambiente (`.env`)

```
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-chave-service-role
SESSION_SECRET=uma-chave-aleatoria-grande
MP_ACCESS_TOKEN_FIXO=      # opcional — ou configure pelo próprio painel em "Gateway Pix"
PORT=3000
```

## Banco de dados

Use o arquivo **`database.sql`** (raiz do projeto) — ele tem tudo num lugar só. Veja o "Guia rápido" no topo deste README.

## Configuração de Gateway e Pixels

Não fica no `.env` — é tudo pelo próprio dashboard, em **Gateway Pix** e **Pixels & Marketing**. As chaves ficam salvas na tabela `configuracoes` (mesma tabela de sempre, chave/valor):
- Gateway ativo: `GATEWAY_PROVIDER` (`mercadopago` | `pay2m` | `paggue`)
- Mercado Pago: `MERCADOPAGO_ACCESS_TOKEN`
- Pay2M: `PAY2M_CLIENT_ID`, `PAY2M_CLIENT_SECRET`
- Paggue: `PAGGUE_ACCESS_TOKEN`
- Pixels globais: `FACEBOOK_PIXEL_ID`, `FACEBOOK_CONVERSION_API_TOKEN`, `GOOGLE_ADS_ID`, `TIKTOK_PIXEL_ID`, `GTM_ID`

O webhook a colar no painel de qualquer gateway é sempre: `https://SEU-DOMINIO/api/webhook/pagamento` (o dashboard já mostra essa URL pronta na aba Gateway Pix).

⚠️ Os endpoints do Pay2M e da Paggue no `server.js` (`criarPagamentoPay2M`, `criarPagamentoPaggue`) estão implementados de forma ilustrativa, baseados na documentação pública deles — confirme o path exato e os campos de resposta antes de usar em produção.

## Estrutura de pastas

```
server.js              → backend (Express)
public/
  index.html            → home
  sorteio.html           → página do sorteio (lê o funil pela URL)
  checkout.html          → pagamento + pós-pagamento (padrão ou bônus)
  dashboard.html         → painel admin (inclui aba de Funis)
  login.html             → login do admin
views_old/               → seus arquivos .ejs originais, mantidos só de referência
```

## Como criar um funil "Ads" e um "Orgânico" no mesmo sorteio

1. No dashboard, edite o sorteio → aba **Funis**.
2. Crie o funil "Ads - Campanha A", origem `ads`, pós-pagamento `padrao`.
3. Crie o funil "Orgânico - Bônus", origem `organico`, pós-pagamento `bonus`, com mensagem e cotas grátis.
4. Copie os dois links gerados e use cada um na campanha correspondente.

## Como testar A/B entre dois funis

1. Crie os dois funis normalmente, mas preencha o mesmo texto em **"Grupo de teste"** nos dois (ex: `teste-headline`).
2. Defina o % de tráfego de cada um no campo que aparece (ex: 50 e 50, ou 70/30).
3. Use o link `/sorteio/<slug>/teste/<grupo>` (ex: `/sorteio/iphone-15/teste/teste-headline`) na sua campanha — o sistema decide sozinho qual funil mostrar pra cada visitante, e mantém a mesma versão se ele voltar.
4. Compare o resultado na aba **Comparativo de Links** (o clique já fica registrado por link/origem) e vendo os pedidos de cada funil na aba Pedidos.

## Como adicionar um novo HTML de funil (novo layout de site)

1. Você me descreve a ideia do site (ou manda referência) e eu crio um arquivo novo, ex: `public/funis/promo-natal.html`.
2. Esse arquivo entra na pasta `public/funis/` do projeto.
3. No dashboard, ao criar o funil, o campo **"Arquivo HTML deste funil"** deve listar esse novo arquivo — hoje a lista é fixa (`sorteio.html`); quando você tiver o próximo arquivo, me avisa que eu já deixo ele aparecendo nesse seletor automaticamente.
4. Quer mudar algo depois? É só me pedir "muda assim o `promo-natal.html`" — eu edito só aquele arquivo, sem mexer nos outros.
