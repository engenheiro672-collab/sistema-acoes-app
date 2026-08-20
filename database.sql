-- ============================================================================
-- SISTEMA DE SORTEIOS — SQL COMPLETO (rode este arquivo inteiro de uma vez)
-- ============================================================================
-- Cole tudo isso no SQL Editor do Supabase (Project → SQL Editor → New query)
-- e clique em "Run". É seguro rodar mais de uma vez (tudo usa IF NOT EXISTS).
-- ============================================================================

-- Extensão necessária pra gerar UUIDs (gen_random_uuid)
create extension if not exists pgcrypto;

-- ============================================================================
-- 1) ADMIN_USERS — quem acessa o painel /dashboard
-- ============================================================================
create table if not exists admin_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  name text,
  status text default 'active', -- 'active' | 'suspended'
  created_at timestamptz default now()
);

-- ============================================================================
-- 2) USUARIOS — os compradores (clientes públicos, não admins)
-- ============================================================================
create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  nome_completo text not null,
  telefone text unique not null,
  email text,
  cpf text,
  endereco text,
  created_at timestamptz default now()
);

-- ============================================================================
-- 3) SORTEIOS
-- ============================================================================
create table if not exists sorteios (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  slug text unique not null,
  descricao text,
  preco_cota numeric(12,2) not null default 0,
  total_cotas integer not null default 1000000,
  -- ⚡ Contador pronto de quantas cotas já foram vendidas — atualizado a cada compra (veja a função
  -- incrementar_cotas_vendidas mais abaixo). Sem isso, toda visita à página do sorteio precisava
  -- CONTAR todas as linhas da tabela "cotas" na hora — rápido com poucas cotas, mas cada vez mais
  -- lento conforme o sorteio cresce (num sorteio de milhões de números, isso sozinho já explica
  -- vários segundos de demora). Ler um número já pronto é instantâneo, não importa o tamanho.
  cotas_vendidas integer not null default 0,
  tempo_pagamento integer default 15,          -- minutos (0 = sem tempo limite)
  minimo_cotas_compra integer default 1,
  maximo_cotas_compra integer default 1000000,
  minimo_visivel_seletor integer default 30,
  botoes_rapidos text,                          -- "500,1000,2000,5000"
  foto_url text,
  fotos_galeria text[] default '{}',
  status text default 'rascunho',               -- 'rascunho' | 'ativo' | 'concluido'
  link_grupo_vip text,
  suporte_whatsapp text,
  ganhador_nome text,
  ganhador_cota text,
  is_featured boolean default false,
  pixel_fb_override text,
  pixel_google_override text,
  pixel_tiktok_override text,
  pixel_gtm_override text,
  coletar_cpf boolean default false,
  coletar_email boolean default false,
  coletar_endereco boolean default false,
  roleta_ativada boolean default false,
  roleta_pool_total integer default 0,
  roleta_giros_por_compra integer default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_sorteios_status on sorteios(status);
create index if not exists idx_sorteios_slug on sorteios(slug);

-- ============================================================================
-- 4) FUNIS — múltiplos sites/funis (landing + checkout) por sorteio
-- ============================================================================
create table if not exists funis (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  nome text not null,
  slug text not null,
  origem text default 'ads',                    -- 'ads' | 'organico' | 'outro' (organizacional)
  arquivo_html text default 'sorteio.html',      -- landing page em public/ ou public/funis/
  arquivo_checkout_html text default 'checkout.html', -- checkout em public/ ou public/funis/
  grupo_teste text,                              -- funis com o mesmo grupo disputam tráfego (A/B)
  peso_trafego integer default 100,              -- % de tráfego dentro do grupo de teste
  pos_pagamento_tipo text default 'padrao',      -- 'padrao' | 'bonus'
  pos_pagamento_titulo text,
  pos_pagamento_mensagem text,
  bonus_cotas_extra integer default 0,
  ativo boolean default true,
  created_at timestamptz default now()
);
create unique index if not exists idx_funis_sorteio_slug on funis(sorteio_id, slug);
create index if not exists idx_funis_grupo_teste on funis(sorteio_id, grupo_teste);

-- ============================================================================
-- 5) LINKS DE RASTREAMENTO — manuais (WhatsApp, Ads...) e automáticos (UTM)
-- ============================================================================
create table if not exists links_rastreamento (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  funil_id uuid references funis(id) on delete set null,  -- opcional: link pode abrir um funil específico
  nome text not null,
  codigo text not null,        -- usado na URL como ?lk=codigo (ou auto-* pra detecção automática)
  canal text default 'outro',  -- whatsapp | instagram_organico | facebook_organico | facebook_ads | google_ads | tiktok_ads | direto | outro
  cliques integer default 0,
  created_at timestamptz default now()
);
create unique index if not exists idx_links_sorteio_codigo on links_rastreamento(sorteio_id, codigo);

-- ============================================================================
-- 6) ACESSOS_LOG — log de acessos com timestamp (filtros de período no dashboard)
-- ============================================================================
create table if not exists acessos_log (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  link_id uuid references links_rastreamento(id) on delete set null,
  created_at timestamptz default now()
);
create index if not exists idx_acessos_log_sorteio_data on acessos_log(sorteio_id, created_at);

-- ============================================================================
-- 7) PEDIDOS
-- ============================================================================
create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  token uuid unique not null default gen_random_uuid(),
  user_id uuid references usuarios(id),
  sorteio_id uuid references sorteios(id) on delete cascade,
  funil_id uuid references funis(id),
  link_id uuid references links_rastreamento(id) on delete set null,
  quantidade_cotas integer not null,
  valor_total numeric(12,2) not null,
  status text default 'aguardando',        -- 'aguardando' | 'pago' | 'cancelado'
  cotas_geradas boolean default false,
  cotas_array text[] default '{}',
  expira_em timestamptz,
  gateway_payment_id text,
  gateway_provider text,
  gateway_data jsonb,
  payment_provider text,
  payment_link text,
  pix_copia_cola text,
  pix_qr_code_base64 text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_pedidos_status on pedidos(status);
create index if not exists idx_pedidos_sorteio on pedidos(sorteio_id);
create index if not exists idx_pedidos_token on pedidos(token);
create index if not exists idx_pedidos_gateway_payment_id on pedidos(gateway_payment_id);

-- ============================================================================
-- 8) COTAS — os números gerados quando um pedido é aprovado
-- ============================================================================
create table if not exists cotas (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  pedido_id uuid references pedidos(id) on delete cascade,
  user_id uuid references usuarios(id),
  numero_cota text not null,
  created_at timestamptz default now()
);
-- 🔒 GARANTIA DE NÃO REPETIÇÃO: essencial pra produção com dinheiro real.
-- Impede, a nível de banco, que a mesma cota seja vendida duas vezes no mesmo sorteio
-- mesmo que dois pagamentos sejam aprovados ao mesmo tempo (o server.js já trata esse
-- conflito e tenta de novo automaticamente quando isso acontece).
create unique index if not exists idx_cotas_sorteio_numero on cotas(sorteio_id, numero_cota);
create index if not exists idx_cotas_pedido on cotas(pedido_id);
create index if not exists idx_cotas_user on cotas(user_id);

-- ⚡ Soma cotas_vendidas de forma ATÔMICA (segura mesmo com várias compras acontecendo ao mesmo
-- tempo — o banco garante isso a nível de linha, sem risco de duas compras simultâneas "pisarem"
-- uma na contagem da outra). Chamada pelo server.js logo depois de gerar as cotas de uma compra.
create or replace function incrementar_cotas_vendidas(p_sorteio_id uuid, p_quantidade integer)
returns void as $$
begin
  update sorteios set cotas_vendidas = coalesce(cotas_vendidas, 0) + p_quantidade where id = p_sorteio_id;
end;
$$ language plpgsql;

-- Se o seu banco já existia ANTES desse contador ser criado, essas duas linhas garantem que ele
-- apareça (sem recriar nada) e já venha com o valor certo, contado uma única vez aqui — nunca
-- mais precisa contar de novo depois disso, só somar a cada nova venda.
alter table sorteios add column if not exists cotas_vendidas integer not null default 0;
update sorteios s set cotas_vendidas = (select count(*) from cotas c where c.sorteio_id = s.id);

-- ============================================================================
-- 9) COTAS_BLOQUEADAS — bloqueio permanente (só sai se você remover manualmente)
-- ============================================================================
create table if not exists cotas_bloqueadas (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  numero_cota text not null,
  created_at timestamptz default now()
);
create unique index if not exists idx_cotas_bloqueadas_sorteio_numero on cotas_bloqueadas(sorteio_id, numero_cota);

-- ============================================================================
-- 10) COTAS_AGENDADAS — bloqueio temporário (libera sozinha numa data/hora)
-- ============================================================================
create table if not exists cotas_agendadas (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  numero_cota text not null,
  liberar_em timestamptz not null,
  condicao_tipo text,          -- 'acima' | 'abaixo' | null (sem condição)
  condicao_quantidade integer, -- quantidade de cotas do pedido pra condição valer
  created_at timestamptz default now()
);
create index if not exists idx_cotas_agendadas_sorteio on cotas_agendadas(sorteio_id, liberar_em);

-- ============================================================================
-- 11) BILHETES_PREMIADOS — bilhete premiado E roleta (diferenciados por "tipo")
-- ============================================================================
create table if not exists bilhetes_premiados (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  numero_cota text not null,          -- pra 'roleta', é o "número do giro" dentro do pool (1..roleta_pool_total), não uma cota real
  premio_titulo text,
  valor_premio text,                       -- usado só pela roleta (texto livre, ex: "R$ 50,00")
  tipo text default 'bilhete',             -- 'bilhete' | 'roleta'
  status text default 'disponivel',        -- 'disponivel' | 'reivindicada'
  usuario_id uuid references usuarios(id), -- preenchido automaticamente quando a cota sai
  pedido_id uuid references pedidos(id),
  reivindicada_em timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_bilhetes_sorteio_tipo on bilhetes_premiados(sorteio_id, tipo);
create index if not exists idx_bilhetes_status on bilhetes_premiados(status);

-- ============================================================================
-- 11b) ROLETA_TIERS — "a cada X títulos comprados, ganha Y giros de roleta"
-- ============================================================================
create table if not exists roleta_tiers (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  minimo_cotas integer not null,
  quantidade_giros integer not null,
  created_at timestamptz default now()
);
create index if not exists idx_roleta_tiers_sorteio on roleta_tiers(sorteio_id, minimo_cotas);

-- ============================================================================
-- 11c) ROLETA_GIROS — os giros que cada pedido ganhou, e o resultado de cada um
-- ============================================================================
create table if not exists roleta_giros (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  pedido_id uuid references pedidos(id) on delete cascade,
  usuario_id uuid references usuarios(id),
  numero_giro integer not null,             -- posição sorteada dentro do pool (1..roleta_pool_total)
  bilhete_premiado_id uuid references bilhetes_premiados(id) on delete set null, -- se bateu com um prêmio pré-configurado
  premio_titulo text,
  valor_premio text,
  cor_sorteada text,                        -- 'verde' | 'vermelho' | 'preto' — cor onde a bolinha parou (roleta por cores)
  pago_dobro boolean default false,         -- true quando caiu no verde (prêmio pago em dobro)
  girado boolean default false,
  girado_em timestamptz,
  created_at timestamptz default now()
);
create index if not exists idx_roleta_giros_pedido on roleta_giros(pedido_id);
-- 🐛 CORREÇÃO DE BUG GRAVE: essa trava original exigia numero_giro único POR SORTEIO INTEIRO —
-- na prática, isso significava que só o PRIMEIRO cliente que ganhasse roleta em cada sorteio
-- conseguia; todo mundo depois falhava silenciosamente ("duplicate key"). O certo é ser único só
-- DENTRO de cada pedido (giro 1, 2, 3... da compra específica de cada pessoa).
create unique index if not exists idx_roleta_giros_pedido_numero on roleta_giros(pedido_id, numero_giro);

-- Se seu banco já existia ANTES da roleta por cores (verde/vermelho/preto) ser implementada, essas
-- duas linhas garantem que as colunas apareçam mesmo sem recriar a tabela do zero:
alter table roleta_giros add column if not exists cor_sorteada text;
alter table roleta_giros add column if not exists pago_dobro boolean default false;

-- ============================================================================
-- 13) CONFIGURACOES — chave/valor genérico (gateway, pixels, nome do sistema, etc.)
-- ============================================================================
create table if not exists configuracoes (
  chave text primary key,
  valor text
);

-- ⚡ Pixels adicionais do Meta — além do pixel principal (guardado em "configuracoes" ou por
-- sorteio), você pode adicionar quantos pixels extras quiser aqui. Todos eles recebem exatamente
-- os mesmos eventos (PageView, Lead, InitiateCheckout, Purchase) com os mesmos valores — é como
-- ter várias "câmeras" gravando o mesmo rastreamento, cada uma pra uma conta de anúncio diferente.
create table if not exists pixels_meta_extras (
  id uuid primary key default gen_random_uuid(),
  nome text,
  pixel_id text not null,
  ativo boolean not null default true,
  created_at timestamptz default now()
);

-- ============================================================================
-- 14e) NOTIFICAÇÕES PUSH — inscrições e disparos
-- ============================================================================
create table if not exists push_inscricoes (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  chave_p256dh text not null,
  chave_auth text not null,
  telefone text,
  user_id uuid references usuarios(id),
  sorteio_id uuid references sorteios(id),
  ativo boolean default true,
  created_at timestamptz default now(),
  desativado_em timestamptz
);
create index if not exists idx_push_inscricoes_ativo on push_inscricoes(ativo);

create table if not exists push_disparos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  mensagem text,
  imagem_url text,
  link_destino text,
  sorteio_id uuid references sorteios(id),
  total_enviado integer default 0,
  total_clicado integer default 0,
  created_at timestamptz default now()
);

-- ============================================================================
-- 14d) PROMOCOES — combos com desconto (ex: "300 títulos por R$10")
-- ============================================================================
create table if not exists promocoes (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  titulo text default 'Promoção',
  quantidade_cotas integer not null,
  preco_promocional numeric not null,
  ativo boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_promocoes_sorteio on promocoes(sorteio_id, ativo);

-- ============================================================================
-- 14b2) UPSELL_OFERTAS — ofertas de upgrade mostradas na hora de confirmar a compra (não na
-- página do sorteio). Duas "etapas": pra quem está comprando pela 1ª vez (só desconto), e pra
-- quem já comprou antes (desconto + roleta extra).
create table if not exists upsell_ofertas (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  etapa text not null default 'primeira_compra', -- 'primeira_compra' | 'segunda_compra_em_diante'
  quantidade_cotas integer not null,
  preco_promocional numeric not null,
  quantidade_giros_roleta integer default 0, -- só usado na etapa 'segunda_compra_em_diante'
  ativo boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_upsell_ofertas_sorteio on upsell_ofertas(sorteio_id, etapa, ativo);

-- ============================================================================
-- 14c) AVISOS_URGENCIA — banners de urgência com contagem regressiva (múltiplos por sorteio)
-- ============================================================================
create table if not exists avisos_urgencia (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  titulo text default '🚨 CORRE QUE ESTÁ ACABANDO 🚨',
  descricao text,
  data_inicio timestamptz not null,
  data_fim timestamptz not null,
  ativo boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_avisos_urgencia_sorteio on avisos_urgencia(sorteio_id, ativo);

-- ============================================================================
-- 14b) CHANCE_DOBRO — dobra as cotas de quem comprar dentro de uma janela de tempo
-- ============================================================================
create table if not exists chance_dobro (
  id uuid primary key default gen_random_uuid(),
  sorteio_id uuid references sorteios(id) on delete cascade,
  titulo text default 'Chance em Dobro',
  data_inicio timestamptz not null,
  data_fim timestamptz not null,
  ativo boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_chance_dobro_sorteio on chance_dobro(sorteio_id, ativo);

-- ============================================================================
-- 14) DESPESAS — pra calcular lucro líquido e ROI em Relatórios
-- ============================================================================
create table if not exists despesas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  valor numeric(12,2) not null,
  data timestamptz default now(),
  created_at timestamptz default now()
);
create index if not exists idx_despesas_data on despesas(data);

-- ============================================================================
-- 🔄 BLOCO DE SINCRONIZAÇÃO — sempre roda por último, sempre seguro.
-- ============================================================================
-- O "CREATE TABLE IF NOT EXISTS" acima só funciona pra tabelas que ainda não existem —
-- ele NÃO adiciona colunas novas numa tabela que você já tinha antes. É por isso que,
-- de tempos em tempos, aparecia erro tipo "Could not find the 'x' column".
-- Esse bloco resolve isso de vez: toda vez que você rodar esse arquivo inteiro (mesmo
-- que seu banco já exista há tempos, em qualquer versão), ele garante que TODAS as
-- colunas que o sistema usa existem — sem apagar nem sobrescrever nada que já tem dado.

-- 🐛 CORREÇÃO DE BUG GRAVE: remove a trava antiga do banco que impedia qualquer cliente, exceto
-- o primeiro, de ganhar giro de roleta em cada sorteio (erro "duplicate key" silencioso).
drop index if exists idx_roleta_giros_sorteio_numero;
create unique index if not exists idx_roleta_giros_pedido_numero on roleta_giros(pedido_id, numero_giro);

alter table admin_users add column if not exists name text;
alter table admin_users add column if not exists status text default 'active';

alter table usuarios add column if not exists email text;
alter table usuarios add column if not exists cpf text;
alter table usuarios add column if not exists endereco text;

alter table sorteios add column if not exists botoes_rapidos text;
alter table sorteios add column if not exists foto_url text;
alter table sorteios add column if not exists fotos_galeria text[] default '{}';
alter table sorteios add column if not exists link_grupo_vip text;
alter table sorteios add column if not exists suporte_whatsapp text;
alter table sorteios add column if not exists ganhador_nome text;
alter table sorteios add column if not exists ganhador_cota text;
alter table sorteios add column if not exists is_featured boolean default false;
alter table sorteios add column if not exists pixel_fb_override text;
alter table sorteios add column if not exists pixel_google_override text;
alter table sorteios add column if not exists pixel_tiktok_override text;
alter table sorteios add column if not exists pixel_gtm_override text;
alter table sorteios add column if not exists coletar_cpf boolean default false;
alter table sorteios add column if not exists coletar_email boolean default false;
alter table sorteios add column if not exists coletar_endereco boolean default false;
alter table sorteios add column if not exists roleta_ativada boolean default false;
alter table sorteios add column if not exists roleta_giros_por_compra integer default 1;

-- 🐛 CORREÇÃO DE BUG: a trava de chave estrangeira original não deixava excluir um prêmio de
-- roleta depois que alguém já tinha ganhado ele (o Postgres bloqueava silenciosamente).
-- Troca pra "ON DELETE SET NULL" — o histórico do giro continua registrado, só perde o vínculo direto.
-- Acha o nome da trava automaticamente (não fica adivinhando), então funciona em qualquer banco.
do $$
declare
  nome_da_trava text;
begin
  select tc.constraint_name into nome_da_trava
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
  where tc.table_name = 'roleta_giros' and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'bilhete_premiado_id'
  limit 1;

  if nome_da_trava is not null then
    execute format('alter table roleta_giros drop constraint %I', nome_da_trava);
  end if;

  alter table roleta_giros add constraint roleta_giros_bilhete_premiado_id_fkey
    foreign key (bilhete_premiado_id) references bilhetes_premiados(id) on delete set null;
exception when others then null; -- se já estiver corrigido ou algo assim, ignora com segurança
end $$;
alter table sorteios add column if not exists roleta_pool_total integer default 0;

-- 🐛 CORREÇÃO DE BUG: a trava de chave estrangeira de pedidos.link_id não deixava excluir um link
-- de rastreamento depois que algum pedido já tinha usado ele (o Postgres bloqueava silenciosamente,
-- com o erro "violates foreign key constraint pedidos_link_id_fkey"). Troca pra "ON DELETE SET
-- NULL" — o pedido continua registrado com todo o histórico, só perde o vínculo direto com o link.
do $$
declare
  nome_da_trava text;
begin
  select tc.constraint_name into nome_da_trava
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
  where tc.table_name = 'pedidos' and tc.constraint_type = 'FOREIGN KEY' and kcu.column_name = 'link_id'
  limit 1;

  if nome_da_trava is not null then
    execute format('alter table pedidos drop constraint %I', nome_da_trava);
  end if;

  alter table pedidos add constraint pedidos_link_id_fkey
    foreign key (link_id) references links_rastreamento(id) on delete set null;
exception when others then null;
end $$;
alter table sorteios add column if not exists updated_at timestamptz default now();
alter table sorteios add column if not exists regulamento text;
alter table sorteios add column if not exists notice_active boolean default false;
alter table sorteios add column if not exists notice_title text;
alter table sorteios add column if not exists notice_description text;
alter table sorteios add column if not exists notice_init_at timestamptz;
alter table sorteios add column if not exists notice_end_at timestamptz;

alter table cotas_agendadas add column if not exists condicao_tipo text;
alter table cotas_agendadas add column if not exists condicao_quantidade integer;

alter table funis add column if not exists arquivo_html text default 'sorteio.html';
alter table funis add column if not exists arquivo_checkout_html text default 'checkout.html';
alter table funis add column if not exists grupo_teste text;
alter table funis add column if not exists peso_trafego integer default 100;
alter table funis add column if not exists pos_pagamento_tipo text default 'padrao';
alter table funis add column if not exists pos_pagamento_titulo text;
alter table funis add column if not exists pos_pagamento_mensagem text;
alter table funis add column if not exists bonus_cotas_extra integer default 0;
alter table funis add column if not exists ativo boolean default true;

alter table links_rastreamento add column if not exists funil_id uuid references funis(id) on delete set null;
alter table links_rastreamento add column if not exists canal text default 'outro';
alter table links_rastreamento add column if not exists cliques integer default 0;

alter table pedidos add column if not exists funil_id uuid references funis(id);
alter table pedidos add column if not exists link_id uuid references links_rastreamento(id);
alter table pedidos add column if not exists cotas_geradas boolean default false;
alter table pedidos add column if not exists cotas_array text[] default '{}';
alter table pedidos add column if not exists gateway_payment_id text;
alter table pedidos add column if not exists gateway_provider text;
alter table pedidos add column if not exists gateway_data jsonb;
alter table pedidos add column if not exists payment_provider text;
alter table pedidos add column if not exists payment_link text;
alter table pedidos add column if not exists pix_copia_cola text;
alter table pedidos add column if not exists pix_qr_code_base64 text;
alter table pedidos add column if not exists updated_at timestamptz default now();
alter table pedidos add column if not exists promocao_titulo text;
alter table pedidos add column if not exists veio_de_combo_roleta boolean default false;
alter table pedidos add column if not exists criado_manualmente_admin boolean default false;
alter table pedidos add column if not exists giros_bonus_upsell integer default 0;

alter table bilhetes_premiados add column if not exists valor_premio text;
alter table bilhetes_premiados add column if not exists tipo text default 'bilhete';
alter table bilhetes_premiados add column if not exists usuario_id uuid references usuarios(id);
alter table bilhetes_premiados add column if not exists pedido_id uuid references pedidos(id);
alter table bilhetes_premiados add column if not exists reivindicada_em timestamptz;
alter table bilhetes_premiados add column if not exists ativo boolean default true;
alter table bilhetes_premiados add column if not exists nome_completo text;

-- ============================================================================
-- FIM DO SQL. Próximos passos:
-- ============================================================================
-- 1. Vá em Storage (menu lateral do Supabase) e crie 2 buckets PÚBLICOS:
--      - "sorteios"  (fotos dos sorteios)
--      - "logos"     (logo do sistema)
--    Marque "Public bucket" = ON nos dois.
--
-- 2. Rode o script de criação do admin depois do deploy:
--      node scripts/criar-admin.js seu@email.com suaSenhaForte
--
-- 3. Pronto — o sistema já está com todas as tabelas que o server.js espera.
-- ============================================================================
