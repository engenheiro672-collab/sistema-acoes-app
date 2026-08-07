# Pasta de Funis Customizados

Todo novo layout de site (funil) que não seja o padrão entra aqui — tanto a **página inicial** (`sorteio.html`) quanto a **página de checkout** (`checkout.html`) podem ser customizadas, cada uma com seu próprio arquivo.

## Como funciona

1. Você me descreve a ideia do site novo (ou manda print/referência) — pode ser só a página inicial, só o checkout, ou os dois.
2. Eu crio o(s) arquivo(s) aqui, por exemplo: `public/funis/promo-natal.html` (landing) e/ou `public/funis/checkout-upsell.html` (checkout com popup de upsell).
3. No dashboard, ao criar/editar o funil, você seleciona esses arquivos nos campos "Arquivo HTML deste funil (página inicial)" e "Arquivo HTML do checkout".
4. Pronto — quem entrar pelo link daquele funil (`/sorteio/<slug>/<funil-slug>`) vê a landing customizada, e ao finalizar a compra é levado pro checkout customizado daquele mesmo funil.

## Por que dois arquivos separados (landing + checkout)?

Porque são etapas diferentes da jornada: a landing é onde a pessoa decide comprar; o checkout é depois que ela já clicou em "Quero participar" — é ali que ficam coisas como o pagamento PIX, a tela de "pagamento aprovado", e futuros popups de upsell/oferta extra. Manter os dois em arquivos separados deixa mais fácil mexer em um sem arriscar quebrar o outro.

## Requisitos técnicos do arquivo de LANDING

- Ler o slug do sorteio e do funil pela URL (`window.location.pathname`), igual o `sorteio.html` padrão faz.
- Buscar os dados via `fetch('/api/public/sorteio/<slug>/funil/<funilSlug>')`.
- Enviar a compra via `POST /api/public/pedidos/iniciar` com `sorteio_id`, `quantidade`, `nome_completo`, `telefone` e `funil_id`.
- Redirecionar pro `redirect` retornado pela API (`/checkout/<token>`) — o servidor já decide sozinho qual arquivo de checkout mostrar, com base no funil do pedido.

## Requisitos técnicos do arquivo de CHECKOUT

- Ler o token pela URL (`window.location.pathname`).
- Buscar os dados via `fetch('/api/public/checkout/<token>')`.
- Fazer polling em `GET /api/public/pedidos/<token>/status` pra saber quando o pagamento foi aprovado.
- É aqui que dá pra adicionar popups de upsell, mensagens diferentes, etc. — me manda a ideia que eu monto.

Na prática: copie o `public/sorteio.html` ou `public/checkout.html` como ponto de partida e só mude o visual (CSS/estrutura) — a parte de JavaScript que conversa com a API pode ficar praticamente igual. Se quiser, me manda o que quer mudar que eu já entrego pronto assim.
