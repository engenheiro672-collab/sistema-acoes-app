/**
 * Backend ES Modules — Sistema de Rifas/Sorteios
 * VERSÃO HTML: front-end 100% HTML/JS estático (sem EJS), consumindo API.
 * NOVO: sistema de FUNIS — vários funis/layouts de venda dentro de um mesmo sorteio.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
import bcrypt from 'bcrypt';
import cookieParser from 'cookie-parser';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { stringify as csvStringify } from 'csv-stringify/sync';
import webPush from 'web-push';
import rateLimit from 'express-rate-limit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ==================================================================
// 🚨 CONFIGURAÇÃO DO MERCADO PAGO
// Recomendado: mover para variável de ambiente MP_ACCESS_TOKEN_FIXO em vez de
// deixar hardcoded aqui. Antes era uma string fixa no código-fonte — corrigido.
// ==================================================================
const MP_ACCESS_TOKEN_FIXO = process.env.MP_ACCESS_TOKEN_FIXO || '';

// ==================================================================
// 🛠️ HELPERS
// ==================================================================

function normalizeNumber(n) {
  if (!n) return null;
  return String(n).replace(/\./g, '').replace(/,/g, '.');
}

function padCota(numero, totalCotas) {
  if (!totalCotas) return String(numero);
  // Dígitos = tamanho do maior índice válido (totalCotas - 1), não do total em si.
  // Ex: 1.000.000 de cotas → índices 0 a 999.999 → 6 dígitos.
  //     10.000.000 de cotas → índices 0 a 9.999.999 → 7 dígitos.
  const digits = String(Math.max(totalCotas - 1, 0)).length;
  return String(numero).padStart(digits, '0');
}

// Corrige automaticamente bilhetes/roleta que ainda estão marcados como "disponível" mas cuja cota
// já foi vendida de verdade (ex: cadastrado depois da compra, ou criado antes dessa verificação existir).
// Roda em toda leitura, então nunca fica "preso" desatualizado.
// bilhetesJaCarregados (opcional): se quem chamou já buscou os bilhetes_premiados desse sorteio,
// passa aqui pra não gastar mais uma consulta ao banco repetindo a mesma busca.
async function sincronizarBilhetesComCotasVendidas(sorteioId, bilhetesJaCarregados) {
  try {
    const pendentes = (bilhetesJaCarregados || (await supabase.from('bilhetes_premiados').select('id, numero_cota, status').eq('sorteio_id', sorteioId)).data || [])
      .filter(b => b.status === 'disponivel');
    if (!pendentes || pendentes.length === 0) return [];
    const numeros = pendentes.map(p => p.numero_cota);
    const { data: cotasVendidas } = await supabase.from('cotas').select('numero_cota, user_id, pedido_id').eq('sorteio_id', sorteioId).in('numero_cota', numeros);
    if (!cotasVendidas || cotasVendidas.length === 0) return [];
    const vendidaMap = cotasVendidas.reduce((acc, c) => (acc[c.numero_cota] = c, acc), {});
    const agora = new Date().toISOString();
    const corrigidos = pendentes.filter(p => vendidaMap[p.numero_cota]);
    await Promise.all(corrigidos.map(p => {
      const c = vendidaMap[p.numero_cota];
      return supabase.from('bilhetes_premiados').update({
        status: 'reivindicada', usuario_id: c.user_id || null, pedido_id: c.pedido_id || null, reivindicada_em: agora
      }).eq('id', p.id);
    }));
    // Devolve os IDs corrigidos + os dados novos, pra quem chamou poder atualizar sua cópia em memória sem consultar de novo.
    return corrigidos.map(p => ({ id: p.id, usuario_id: vendidaMap[p.numero_cota].user_id || null, pedido_id: vendidaMap[p.numero_cota].pedido_id || null, status: 'reivindicada', reivindicada_em: agora }));
  } catch (e) { console.error('sincronizarBilhetesComCotasVendidas', e); return []; }
}

// Configura o web-push com as chaves VAPID (do .env ou geradas via scripts/gerar-chaves-push.js)
let PUSH_CONFIGURADO = false;
function configurarPush() {
  if (PUSH_CONFIGURADO) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;
  webPush.setVapidDetails('mailto:contato@sistema-sorteios.com', publicKey, privateKey);
  PUSH_CONFIGURADO = true;
  return true;
}

async function safeUpdatePedidos(id, payload) {
  try {
    const { data, error } = await supabase.from('pedidos').update(payload).eq('id', id);
    if (error && String(error.message).toLowerCase().includes('column') && payload.cotas_geradas !== undefined) {
      const { cotas_geradas, ...rest } = payload;
      return await supabase.from('pedidos').update(rest).eq('id', id);
    }
    return { data, error };
  } catch (err) {
    console.error('safeUpdatePedidos err', err);
    return { data: null, error: err };
  }
}

// Detecta automaticamente a origem do acesso (Google Ads, Facebook/Instagram Ads, WhatsApp, orgânico...)
function detectarOrigemAutomatica(query, referer, funil) {
  const q = query || {};
  const sufixo = funil ? `--${funil.slug}` : '';
  const nomeFunil = funil ? ` (funil: ${funil.nome})` : '';
  if (q.gclid) return { codigo: `auto-google-ads${sufixo}`, nome: `Google Ads (automático)${nomeFunil}`, canal: 'google_ads' };
  if (q.fbclid) return { codigo: `auto-facebook-ads${sufixo}`, nome: `Facebook/Instagram Ads (automático)${nomeFunil}`, canal: 'facebook_ads' };
  if (q.ttclid) return { codigo: `auto-tiktok-ads${sufixo}`, nome: `TikTok Ads (automático)${nomeFunil}`, canal: 'tiktok_ads' };
  const utmSource = (q.utm_source || '').toLowerCase();
  if (utmSource.includes('whatsapp') || utmSource === 'wpp') return { codigo: `auto-whatsapp${sufixo}`, nome: `WhatsApp (automático)${nomeFunil}`, canal: 'whatsapp' };
  if (utmSource.includes('instagram')) return { codigo: `auto-instagram-organico${sufixo}`, nome: `Instagram Orgânico (automático)${nomeFunil}`, canal: 'instagram_organico' };
  if (utmSource.includes('facebook')) return { codigo: `auto-facebook-organico${sufixo}`, nome: `Facebook Orgânico (automático)${nomeFunil}`, canal: 'facebook_organico' };
  if (utmSource) return { codigo: `auto-${utmSource}${sufixo}`, nome: `${utmSource} (automático)${nomeFunil}`, canal: 'outro' };
  // Atenção: WhatsApp e Instagram costumam abrir links no navegador interno deles (in-app browser),
  // que MUITAS VEZES não envia o cabeçalho "referer" por privacidade — nesse caso não tem como
  // detectar automaticamente e o acesso cai em "direto/orgânico". Pra rastreio garantido desses
  // canais, o ideal é sempre usar um link manual (aba Links) em vez de depender só da detecção automática.
  if (referer && /whatsapp/i.test(referer)) return { codigo: `auto-whatsapp${sufixo}`, nome: `WhatsApp (automático)${nomeFunil}`, canal: 'whatsapp' };
  if (referer && /instagram/i.test(referer)) return { codigo: `auto-instagram-organico${sufixo}`, nome: `Instagram Orgânico (automático)${nomeFunil}`, canal: 'instagram_organico' };
  if (referer && /facebook/i.test(referer)) return { codigo: `auto-facebook-organico${sufixo}`, nome: `Facebook Orgânico (automático)${nomeFunil}`, canal: 'facebook_organico' };
  return { codigo: `auto-direto${sufixo}`, nome: `Link Oficial do Sorteio${nomeFunil}`, canal: 'direto' };
}

// Garante que um link de rastreamento existe (cria automaticamente se for detecção automática) e incrementa cliques
async function registrarClique(sorteio_id, codigo, nome, canal, funil_id) {
  try {
    if (!sorteio_id || !codigo) return null;
    const { data: existente } = await supabase.from('links_rastreamento').select('*').eq('sorteio_id', sorteio_id).eq('codigo', codigo).maybeSingle();
    let linkId;
    if (existente) {
      await supabase.from('links_rastreamento').update({ cliques: (existente.cliques || 0) + 1 }).eq('id', existente.id);
      linkId = existente.id;
    } else {
      const { data: novo } = await supabase.from('links_rastreamento').insert({
        sorteio_id, codigo, nome: nome || codigo, canal: canal || 'outro', funil_id: funil_id || null, cliques: 1, created_at: new Date().toISOString()
      }).select().single();
      linkId = novo?.id || null;
    }
    // Log com timestamp — permite filtrar acessos por período no dashboard (o contador em cliques é só o total acumulado)
    await supabase.from('acessos_log').insert({ sorteio_id, link_id: linkId, created_at: new Date().toISOString() });
    return linkId;
  } catch (err) { console.error('registrarClique error', err); return null; }
}

// Seleciona um funil por peso (para teste A/B) de forma pseudo-aleatória
function selecionarFunilPorPeso(funis) {
  const ativos = (funis || []).filter(f => f.ativo !== false);
  if (ativos.length === 0) return null;
  const pesoTotal = ativos.reduce((s, f) => s + (Number(f.peso_trafego) || 100), 0);
  let sorteio = Math.random() * pesoTotal;
  for (const f of ativos) {
    sorteio -= (Number(f.peso_trafego) || 100);
    if (sorteio <= 0) return f;
  }
  return ativos[0];
}

function gerarCpfValido() {
  const rnd = (n) => Math.round(Math.random() * n);
  const mod = (dividend, divisor) => Math.round(dividend - (Math.floor(dividend / divisor) * divisor));
  const n1 = rnd(9); const n2 = rnd(9); const n3 = rnd(9);
  const n4 = rnd(9); const n5 = rnd(9); const n6 = rnd(9);
  const n7 = rnd(9); const n8 = rnd(9); const n9 = rnd(9);
  let d1 = n9 * 2 + n8 * 3 + n7 * 4 + n6 * 5 + n5 * 6 + n4 * 7 + n3 * 8 + n2 * 9 + n1 * 10;
  d1 = 11 - (mod(d1, 11)); if (d1 >= 10) d1 = 0;
  let d2 = d1 * 2 + n9 * 3 + n8 * 4 + n7 * 5 + n6 * 6 + n5 * 7 + n4 * 8 + n3 * 9 + n2 * 10 + n1 * 11;
  d2 = 11 - (mod(d2, 11)); if (d2 >= 10) d2 = 0;
  return `${n1}${n2}${n3}${n4}${n5}${n6}${n7}${n8}${n9}${d1}${d2}`;
}

// ==================================================================
// ⚙️ SETUP SERVIDOR
// ==================================================================

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
// Necessário no Render (e qualquer host atrás de proxy/HTTPS) pra sessão/cookies funcionarem certo
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'troque_esta_chave_secreta_agora',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    secure: process.env.NODE_ENV === 'production',   // exige HTTPS em produção (Render já fornece)
    sameSite: 'lax'
  }
}));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use('/api/webhook/pagamento', express.raw({ type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '20mb' }));

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
if (!process.env.SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY em .env');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, SUPABASE_KEY);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

function ok(res, payload = {}) { return res.json({ status: 'success', ...payload }); }
function fail(res, message = 'Erro interno', code = 500) { return res.status(code).json({ status: 'error', error: message }); }

async function fetchConfigFromDB() {
  try {
    const { data, error } = await supabase.from('configuracoes').select('*');
    if (error) return {};
    const obj = {};
    (data || []).forEach(r => {
      const k = r.chave || r.key;
      const v = r.valor || r.value;
      if (k) obj[k] = v;
    });
    return obj;
  } catch { return {}; }
}

async function loadConfigToEnv() {
  const cfg = await fetchConfigFromDB();
  Object.entries(cfg).forEach(([k, v]) => { if (!process.env[k]) process.env[k] = v; });
  if (!process.env.MERCADOPAGO_ACCESS_TOKEN && process.env.MP_ACCESS_TOKEN) {
    process.env.MERCADOPAGO_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  }
  return cfg;
}
await loadConfigToEnv();

async function getPublicMeta() {
  const cfg = await fetchConfigFromDB();
  return {
    logo_url: cfg.LOGO_URL || process.env.LOGO_URL || '',
    pixel_id: cfg.FACEBOOK_PIXEL_ID || process.env.FACEBOOK_PIXEL_ID || '',
    pixel_google: cfg.GOOGLE_ADS_ID || '',
    pixel_tiktok: cfg.TIKTOK_PIXEL_ID || '',
    pixel_gtm: cfg.GTM_ID || '',
    redes_sociais: {
      instagram: { ativo: cfg.SOCIAL_INSTAGRAM_ATIVO === 'true', url: cfg.SOCIAL_INSTAGRAM_URL || '' },
      telegram: { ativo: cfg.SOCIAL_TELEGRAM_ATIVO === 'true', url: cfg.SOCIAL_TELEGRAM_URL || '' },
      facebook: { ativo: cfg.SOCIAL_FACEBOOK_ATIVO === 'true', url: cfg.SOCIAL_FACEBOOK_URL || '' },
      whatsapp_grupo: { ativo: cfg.SOCIAL_WHATSAPP_GRUPO_ATIVO === 'true', url: cfg.SOCIAL_WHATSAPP_GRUPO_URL || '' },
      whatsapp_suporte: { ativo: cfg.SOCIAL_WHATSAPP_SUPORTE_ATIVO === 'true', numero: cfg.SOCIAL_WHATSAPP_SUPORTE_NUMERO || '' }
    },
    push_ativo: cfg.PUSH_ATIVO === 'true'
  };
}

// Auth Middleware
function ensureAdminAuth(req, res, next) {
  if (req.session?.admin?.email) return next();
  if (req.path.startsWith('/api/admin')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/admin/login');
}

// ==================================================================
// 📁 ARQUIVOS ESTÁTICOS (front-end 100% HTML/JS)
// ==================================================================
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, filePath) => {
    // CSS/JS/imagens ficam guardados no celular da pessoa por 7 dias — carrega instantâneo depois da 1ª vez.
    // HTML nunca guarda em cache, pra qualquer atualização sua aparecer na hora, sem a pessoa precisar limpar nada.
    if (/\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

function sendPage(res, file) {
  return res.sendFile(path.join(PUBLIC_DIR, file));
}

// ==================================================================
// 🔐 LOGIN ADMIN
// ==================================================================
app.get('/admin/login', (_req, res) => sendPage(res, 'login.html'));

// Trava contra força bruta: no máximo 8 tentativas de login por IP a cada 15 minutos.
const limiteLoginAdmin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', error: 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.' }
});

app.post('/admin/login', limiteLoginAdmin, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 'Email e senha obrigatórios', 400);
    const { data: user } = await supabase.from('admin_users').select('*').eq('email', email).maybeSingle();
    // Mensagem sempre igual, exista ou não o e-mail — evita que alguém descubra quais contas existem no sistema
    const credenciaisInvalidas = () => fail(res, 'E-mail ou senha incorretos.', 401);
    if (!user) return credenciaisInvalidas();
    if (user.status === 'suspended') return fail(res, 'Conta suspensa', 403);
    const okPass = await bcrypt.compare(password, user.password_hash || '');
    if (!okPass) return credenciaisInvalidas();
    req.session.admin = { id: user.id, email: user.email, name: user.name || 'Admin' };
    return ok(res, { redirect: '/dashboard' });
  } catch (err) { console.error('admin login error', err); return fail(res, 'Erro no login'); }
});

app.post('/admin/logout', (req, res) => { req.session.destroy(() => ok(res, { redirect: '/admin/login' })); });

app.get('/api/admin/session', (req, res) => {
  if (req.session?.admin?.email) return ok(res, { authenticated: true, admin: req.session.admin });
  return res.status(401).json({ status: 'error', authenticated: false });
});

app.get('/dashboard', ensureAdminAuth, (_req, res) => sendPage(res, 'dashboard.html'));

// ==================================================================
// 🌐 PÁGINAS PÚBLICAS (servem HTML estático; dados vêm via /api/public/*)
// ==================================================================
app.get('/', (_req, res) => res.redirect('/inicio'));
app.get('/inicio', (_req, res) => sendPage(res, 'index.html'));
// Middleware de rastreamento: roda em qualquer acesso à página do sorteio.
// Detecta link manual (?lk=codigo) ou origem automática (utm/gclid/fbclid) e registra o clique.
async function trackearAcesso(req, res, next) {
  try {
    const { data: sorteio } = await supabase.from('sorteios').select('id').eq('slug', req.params.slug).maybeSingle();
    if (sorteio) {
      let funil = null;
      if (req.params.funilSlug) {
        const { data: f } = await supabase.from('funis').select('id, nome, slug').eq('sorteio_id', sorteio.id).eq('slug', req.params.funilSlug).maybeSingle();
        funil = f || null;
      }
      if (req.query.lk) {
        const { data: link } = await supabase.from('links_rastreamento').select('*').eq('sorteio_id', sorteio.id).eq('codigo', req.query.lk).maybeSingle();
        if (link) {
          await supabase.from('links_rastreamento').update({ cliques: (link.cliques || 0) + 1 }).eq('id', link.id);
          await supabase.from('acessos_log').insert({ sorteio_id: sorteio.id, link_id: link.id, created_at: new Date().toISOString() });
        }
      } else {
        const auto = detectarOrigemAutomatica(req.query, req.headers.referer, funil);
        await registrarClique(sorteio.id, auto.codigo, auto.nome, auto.canal, funil?.id);
      }
    }
  } catch (err) { console.error('trackearAcesso error', err); }
  next();
}

app.get('/sorteio/:slug', trackearAcesso, (_req, res) => sendPage(res, 'sorteio.html'));

// Serve o HTML correto para o funil: cada funil pode apontar pra um arquivo diferente em public/funis/
app.get('/sorteio/:slug/:funilSlug', trackearAcesso, async (req, res) => {
  try {
    const { slug, funilSlug } = req.params;
    const { data: sorteio } = await supabase.from('sorteios').select('id').eq('slug', slug).maybeSingle();
    if (sorteio) {
      const { data: funil } = await supabase.from('funis').select('arquivo_html').eq('sorteio_id', sorteio.id).eq('slug', funilSlug).maybeSingle();
      const arquivo = funil?.arquivo_html || 'sorteio.html';
      // Arquivos customizados ficam em public/funis/; 'sorteio.html' é o layout padrão em public/
      if (arquivo && arquivo !== 'sorteio.html') {
        const customPath = path.join(PUBLIC_DIR, 'funis', arquivo);
        if (fs.existsSync(customPath)) return res.sendFile(customPath);
      }
    }
  } catch (err) { console.error('Erro ao resolver arquivo do funil', err); }
  return sendPage(res, 'sorteio.html');
});

// Link de TESTE A/B: distribui o tráfego entre os funis de um "grupo_teste" conforme o peso configurado,
// mantendo a mesma versão pro mesmo visitante via cookie.
app.get('/sorteio/:slug/teste/:grupo', async (req, res) => {
  try {
    const { slug, grupo } = req.params;
    const { data: sorteio } = await supabase.from('sorteios').select('id').eq('slug', slug).maybeSingle();
    if (!sorteio) return res.redirect(`/sorteio/${slug}`);

    const cookieName = `ab_${sorteio.id}_${grupo}`;
    const sticky = req.cookies?.[cookieName];

    const { data: funis } = await supabase.from('funis').select('*').eq('sorteio_id', sorteio.id).eq('grupo_teste', grupo);
    if (!funis || funis.length === 0) return res.redirect(`/sorteio/${slug}`);

    let escolhido = sticky ? funis.find(f => f.slug === sticky) : null;
    if (!escolhido) escolhido = selecionarFunilPorPeso(funis);
    if (!escolhido) return res.redirect(`/sorteio/${slug}`);

    res.cookie(cookieName, escolhido.slug, { maxAge: 1000 * 60 * 60 * 24 * 30 });
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(`/sorteio/${slug}/${escolhido.slug}${qs ? '?' + qs : ''}`);
  } catch (err) { console.error('teste A/B error', err); return res.redirect(`/sorteio/${req.params.slug}`); }
});
// Serve o checkout correto: se o pedido veio de um funil com checkout customizado, usa aquele arquivo
app.get('/checkout/:token/:status?', async (req, res) => {
  try {
    const { data: pedido } = await supabase.from('pedidos').select('funil_id').eq('token', req.params.token).maybeSingle();
    if (pedido?.funil_id) {
      const { data: funil } = await supabase.from('funis').select('arquivo_checkout_html').eq('id', pedido.funil_id).maybeSingle();
      const arquivo = funil?.arquivo_checkout_html || 'checkout.html';
      if (arquivo && arquivo !== 'checkout.html') {
        const customPath = path.join(PUBLIC_DIR, 'funis', arquivo);
        if (fs.existsSync(customPath)) return res.sendFile(customPath);
      }
    }
  } catch (err) { console.error('Erro ao resolver checkout do funil', err); }
  return sendPage(res, 'checkout.html');
});

// ==================================================================
// 📡 API PÚBLICA — DADOS PARA AS PÁGINAS HTML
// ==================================================================

app.get('/api/public/inicio', async (_req, res) => {
  try {
    const { data: sorteios } = await supabase.from('sorteios').select('*').eq('status', 'ativo').order('is_featured', { ascending: false }).order('created_at', { ascending: false });
    const { data: ganhadores } = await supabase.from('sorteios').select('id,nome,slug,ganhador_nome,ganhador_cota').eq('status', 'concluido').not('ganhador_nome', 'is', null).limit(5).order('updated_at', { ascending: false });
    const meta = await getPublicMeta();
    const pixels = { facebook_pixel_id: meta.pixel_id, google_ads_id: meta.pixel_google, tiktok_pixel_id: meta.pixel_tiktok, gtm_id: meta.pixel_gtm };
    return ok(res, { sorteios: sorteios || [], ganhadores: ganhadores || [], ...meta, pixels });
  } catch (err) { console.error('GET /api/public/inicio', err); return fail(res); }
});

async function getSorteioPublicData(slug, funilSlug) {
  const { data: sorteio } = await supabase.from('sorteios').select('*').eq('slug', slug).maybeSingle();
  if (!sorteio) return null;

  // Tudo que NÃO depende do resultado de outra consulta roda de uma vez só, em paralelo —
  // antes disso, cada uma dessas ia uma atrás da outra, e cada "ida e volta" ao banco custa tempo.
  const nowISO2 = new Date().toISOString();
  const [
    { count: vendidas },
    { data: bloqueadas },
    { data: agendadas },
    { data: bilhetesTudo },
    { data: roleta_tiers },
    { data: funilData },
    { data: chancesDobroTodas },
    { data: avisosTodos },
    { data: promocoesAtivas },
    meta
  ] = await Promise.all([
    supabase.from('cotas').select('*', { head: true, count: 'exact' }).eq('sorteio_id', sorteio.id),
    supabase.from('cotas_bloqueadas').select('numero_cota').eq('sorteio_id', sorteio.id),
    supabase.from('cotas_agendadas').select('numero_cota, release_at, liberar_em').eq('sorteio_id', sorteio.id),
    supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', sorteio.id).order('status', { ascending: false }),
    sorteio.roleta_ativada
      ? supabase.from('roleta_tiers').select('*').eq('sorteio_id', sorteio.id).order('minimo_cotas', { ascending: true })
      : Promise.resolve({ data: [] }),
    funilSlug
      ? supabase.from('funis').select('*').eq('sorteio_id', sorteio.id).eq('slug', funilSlug).eq('ativo', true).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('chance_dobro').select('*').eq('sorteio_id', sorteio.id).eq('ativo', true),
    supabase.from('avisos_urgencia').select('*').eq('sorteio_id', sorteio.id).eq('ativo', true),
    supabase.from('promocoes').select('*').eq('sorteio_id', sorteio.id).eq('ativo', true).order('quantidade_cotas', { ascending: true }),
    getPublicMeta()
  ]);

  // Corrige em memória qualquer bilhete que já foi vendido mas ainda tava marcado como disponível
  // (reaproveita o bilhetesTudo que já veio ali de cima — não gasta outra consulta pra isso)
  const correcoes = await sincronizarBilhetesComCotasVendidas(sorteio.id, bilhetesTudo || []);
  const correcaoMap = correcoes.reduce((a, c) => (a[c.id] = c, a), {});
  const bilhetesCorrigidos = (bilhetesTudo || []).map(b => correcaoMap[b.id] ? { ...b, ...correcaoMap[b.id] } : b);

  const nowISO = nowISO2;
  const bloq = new Set((bloqueadas || []).map(b => b.numero_cota));
  const agnd = new Set((agendadas || []).filter(a => (a.release_at || a.liberar_em) && (a.release_at || a.liberar_em) > nowISO).map(a => a.numero_cota));
  const restantes = Math.max(0, Number(sorteio.total_cotas || 0) - Number(vendidas || 0) - bloq.size - agnd.size);
  const bilhetes = bilhetesCorrigidos.filter(b => (b.tipo || 'bilhete') === 'bilhete');
  const roletaTodos = bilhetesCorrigidos.filter(b => b.tipo === 'roleta');

  // Esses dois lookups de usuário dependem de quem ganhou (resultado de cima), então precisam
  // rodar depois — mas ainda dá pra rodar os dois AO MESMO TEMPO um com o outro.
  const usuarioIdsBilhetes = [...new Set(bilhetes.filter(b => b.status === 'reivindicada').map(b => b.usuario_id).filter(Boolean))];
  const roletaGanhas = roletaTodos.filter(r => r.status === 'reivindicada');
  const roletaDisponiveis = roletaTodos.filter(r => r.status !== 'reivindicada');
  const usuarioIdsRoleta = [...new Set(roletaGanhas.map(r => r.usuario_id).filter(Boolean))];

  const [{ data: usuariosBilhetes }, { data: usuariosRoleta }] = await Promise.all([
    usuarioIdsBilhetes.length ? supabase.from('usuarios').select('id, nome_completo').in('id', usuarioIdsBilhetes) : Promise.resolve({ data: [] }),
    usuarioIdsRoleta.length ? supabase.from('usuarios').select('id, nome_completo').in('id', usuarioIdsRoleta) : Promise.resolve({ data: [] })
  ]);
  const usuarioMapBilhetes = (usuariosBilhetes || []).reduce((a, u) => (a[u.id] = u.nome_completo, a), {});
  const usuarioMapRoleta = (usuariosRoleta || []).reduce((a, u) => (a[u.id] = u.nome_completo, a), {});

  // 🔒 Nunca expõe o número da cota de um bilhete premiado que AINDA NÃO SAIU — só depois de reivindicado
  // (mesma regra que já era aplicada certinho pra roleta). Enquanto está disponível, ninguém pode saber
  // qual é o número secreto, senão vira um jeito de tentar "caçar" a cota premiada antes de comprar.
  const bilhetesComNome = bilhetes.map(b => ({
    numero_cota: b.status === 'reivindicada' ? b.numero_cota : null,
    premio_titulo: b.premio_titulo,
    status: b.status,
    ativo: b.ativo,
    ganhador_nome: b.status === 'reivindicada' ? (usuarioMapBilhetes[b.usuario_id] || b.nome_completo || null) : null
  }));

  // Roleta: nunca expõe o número do giro — só título/valor/nome de quem ganhou (igual ao site de referência)
  const roleta_resultados = {
    total: roletaTodos.length,
    ganhas: roletaGanhas.length,
    // Lista completa (ganhas primeiro, depois disponíveis) — nunca inclui numero_cota
    lista: [
      ...roletaGanhas.map(r => ({ premio_titulo: r.premio_titulo, valor_premio: r.valor_premio, ganhador_nome: usuarioMapRoleta[r.usuario_id] || r.nome_completo || null, reivindicada: true })),
      ...roletaDisponiveis.map(r => ({ premio_titulo: r.premio_titulo, valor_premio: r.valor_premio, ganhador_nome: null, reivindicada: false }))
    ]
  };

  const funil = funilData || null;

  const pixels = {
    facebook_pixel_id: sorteio.pixel_fb_override || meta.pixel_id || '',
    google_ads_id: sorteio.pixel_google_override || meta.pixel_google || '',
    tiktok_pixel_id: sorteio.pixel_tiktok_override || meta.pixel_tiktok || '',
    gtm_id: sorteio.pixel_gtm_override || meta.pixel_gtm || ''
  };
  const chance_dobro_ativa = (chancesDobroTodas || []).find(c => c.data_inicio <= nowISO2 && c.data_fim >= nowISO2) || null;
  const aviso_urgencia_ativo = (avisosTodos || []).find(a => a.data_inicio <= nowISO2 && a.data_fim >= nowISO2) || null;

  return { sorteio, bilhetes_premiados: bilhetesComNome, roleta_tiers: roleta_tiers || [], roleta_resultados, cotas_vendidas: vendidas || 0, restantes, funil, ...meta, pixels, chance_dobro_ativa, aviso_urgencia_ativo, promocoes: promocoesAtivas || [] };
}

app.get('/api/public/sorteio/:slug', async (req, res) => {
  try {
    const data = await getSorteioPublicData(req.params.slug, req.query.funil || null);
    if (!data) return res.status(404).json({ error: 'Sorteio não encontrado' });
    return ok(res, data);
  } catch (err) { console.error('GET /api/public/sorteio/:slug', err); return fail(res); }
});

app.get('/api/public/sorteio/:slug/funil/:funilSlug', async (req, res) => {
  try {
    const data = await getSorteioPublicData(req.params.slug, req.params.funilSlug);
    if (!data) return res.status(404).json({ error: 'Sorteio não encontrado' });
    return ok(res, data);
  } catch (err) { console.error('GET /api/public/sorteio/:slug/funil/:funilSlug', err); return fail(res); }
});

async function getCheckoutPublicData(token) {
  const { data: pedido } = await supabase.from('pedidos').select('*, sorteios(*), usuarios(nome_completo, telefone, cpf)').eq('token', token).maybeSingle();
  if (!pedido) return null;
  const minutos_restantes = pedido.expira_em ? Math.max(0, (new Date(pedido.expira_em).getTime() - Date.now()) / 60000) : 0;
  let cotas_geradas = [];
  if (pedido.status === 'pago') {
    cotas_geradas = Array.isArray(pedido.cotas_array) ? pedido.cotas_array.map(n => ({ numero_cota: n })) : [];
  }
  const isPago = pedido.status === 'pago';
  const derived_status = (isPago ? 'aprovado' : (pedido.expira_em && new Date(pedido.expira_em).getTime() < Date.now() ? 'expirado' : 'pendente'));

  let funil = null;
  if (pedido.funil_id) {
    const { data: f } = await supabase.from('funis').select('*').eq('id', pedido.funil_id).maybeSingle();
    funil = f || null;
  }

  const meta = await getPublicMeta();
  const sorteioDoPedido = pedido.sorteios || {};
  const pixels = {
    facebook_pixel_id: sorteioDoPedido.pixel_fb_override || meta.pixel_id || '',
    google_ads_id: sorteioDoPedido.pixel_google_override || meta.pixel_google || '',
    tiktok_pixel_id: sorteioDoPedido.pixel_tiktok_override || meta.pixel_tiktok || '',
    gtm_id: sorteioDoPedido.pixel_gtm_override || meta.pixel_gtm || ''
  };
  const cfg = await fetchConfigFromDB();
  const modo_teste_pagamento = cfg.MODO_TESTE_PAGAMENTO === 'true' || cfg.MODO_TESTE_PAGAMENTO === 'on';

  let roleta_tiers = [];
  if (sorteioDoPedido.roleta_ativada) {
    const { data: tiers } = await supabase.from('roleta_tiers').select('*').eq('sorteio_id', sorteioDoPedido.id).order('minimo_cotas', { ascending: true });
    roleta_tiers = tiers || [];
  }

  return { pedido, minutos_restantes, cotas_geradas, isPago, derived_status, funil, ...meta, pixels, modo_teste_pagamento, roleta_tiers };
}

app.get('/api/public/checkout/:token', async (req, res) => {
  try {
    const data = await getCheckoutPublicData(req.params.token);
    if (!data) return res.status(404).json({ error: 'Pedido não encontrado ou expirado.' });
    return ok(res, data);
  } catch (err) { console.error('GET /api/public/checkout/:token', err); return fail(res); }
});

// Lista os giros de roleta de um pedido (sem revelar o resultado dos que ainda não foram girados)
app.get('/api/public/pedidos/:token/roletas', async (req, res) => {
  try {
    const { data: pedido } = await supabase.from('pedidos').select('id').eq('token', req.params.token).maybeSingle();
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    const { data: giros } = await supabase.from('roleta_giros').select('*').eq('pedido_id', pedido.id).order('created_at', { ascending: true });
    const publico = (giros || []).map(g => ({
      id: g.id, girado: g.girado,
      premio_titulo: g.girado ? g.premio_titulo : null,
      valor_premio: g.girado ? g.valor_premio : null,
      ganhou: g.girado ? !!g.premio_titulo : null
    }));
    return ok(res, { giros: publico });
  } catch (err) { console.error('GET pedidos/:token/roletas', err); return fail(res); }
});

// "Gira" um giro específico — o resultado já estava determinado desde a aprovação do pagamento,
// aqui só revelamos e, se for prêmio, confirmamos a reivindicação do bilhete de roleta correspondente.
app.post('/api/public/roletas/:giroId/girar', async (req, res) => {
  try {
    const { data: giro } = await supabase.from('roleta_giros').select('*').eq('id', req.params.giroId).maybeSingle();
    if (!giro) return res.status(404).json({ error: 'Giro não encontrado' });
    if (giro.girado) return ok(res, { premio_titulo: giro.premio_titulo, valor_premio: giro.valor_premio, ganhou: !!giro.premio_titulo });

    await supabase.from('roleta_giros').update({ girado: true, girado_em: new Date().toISOString() }).eq('id', giro.id);

    if (giro.bilhete_premiado_id) {
      await supabase.from('bilhetes_premiados').update({
        status: 'reivindicada', usuario_id: giro.usuario_id, pedido_id: giro.pedido_id, reivindicada_em: new Date().toISOString()
      }).eq('id', giro.bilhete_premiado_id).eq('status', 'disponivel');
    }

    return ok(res, { premio_titulo: giro.premio_titulo, valor_premio: giro.valor_premio, ganhou: !!giro.premio_titulo });
  } catch (err) { console.error('POST roletas/:giroId/girar', err); return fail(res); }
});

// 🧪 MODO TESTE — só funciona se MODO_TESTE_PAGAMENTO estiver ligado nas configurações.
// Serve pra você testar o fluxo inteiro (sorteio → checkout → cotas geradas) sem ter um gateway
// de pagamento real configurado ainda. NÃO envolve dinheiro real. Desligue antes de divulgar o link pra clientes.
app.post('/api/public/pedidos/:token/confirmar-teste', async (req, res) => {
  try {
    const cfg = await fetchConfigFromDB();
    const ligado = cfg.MODO_TESTE_PAGAMENTO === 'true' || cfg.MODO_TESTE_PAGAMENTO === 'on';
    if (!ligado) return res.status(403).json({ error: 'Modo teste de pagamento está desligado. Ligue em Gateway Pix no painel se quiser testar sem um gateway real.' });

    const { data: pedido } = await supabase.from('pedidos').select('*').eq('token', req.params.token).maybeSingle();
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (pedido.status === 'pago') return ok(res, { já_estava_pago: true });

    const cotas = await gerarCotasUnicas(pedido);
    if (!cotas || cotas.length === 0) return fail(res, 'Falha ao gerar cotas de teste', 400);
    return ok(res, { cotas });
  } catch (err) { console.error('POST confirmar-teste', err); return fail(res); }
});

// Consulta de bilhetes por telefone (usada pelo modal "Meus Bilhetes")
app.post('/api/public/meus-bilhetes', async (req, res) => {
  try {
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    if (!telefone) return fail(res, 'Telefone é obrigatório', 400);
    const { data: usuario } = await supabase.from('usuarios').select('id').eq('telefone', telefone).maybeSingle();
    if (!usuario) return res.json([]);
    const { data: pedidos } = await supabase.from('pedidos')
      .select('*, sorteios(nome, slug), cotas(numero_cota)')
      .eq('user_id', usuario.id)
      .eq('status', 'pago')
      .order('created_at', { ascending: false });
    const results = (pedidos || []).map(p => ({ ...p, cotas: p.cotas || [] }));
    return res.json(results);
  } catch (err) { console.error('POST /api/public/meus-bilhetes', err); return fail(res); }
});

// Verifica se um telefone já é de um comprador conhecido (pra pular nome/CPF/etc no checkout)
app.post('/api/public/usuarios/verificar', async (req, res) => {
  try {
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    if (!telefone) return fail(res, 'Telefone é obrigatório', 400);
    const { data: usuario } = await supabase.from('usuarios').select('nome_completo, email, cpf, endereco').eq('telefone', telefone).maybeSingle();
    if (!usuario) return ok(res, { existe: false });
    return ok(res, {
      existe: true, nome_completo: usuario.nome_completo,
      tem_email: !!usuario.email, tem_cpf: !!usuario.cpf, tem_endereco: !!usuario.endereco
    });
  } catch (err) { console.error('POST usuarios/verificar', err); return fail(res); }
});

// --- PAGAMENTOS ---

async function criarPagamentoMercadoPago(pedido, usuario) {
  const cfg = await fetchConfigFromDB();
  let ACCESS_TOKEN = (MP_ACCESS_TOKEN_FIXO && MP_ACCESS_TOKEN_FIXO.length > 20)
    ? MP_ACCESS_TOKEN_FIXO
    : (cfg.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN);

  if (!ACCESS_TOKEN) {
    console.warn('⚠️ Mercado Pago: Token não encontrado!');
    return null;
  }
  if (ACCESS_TOKEN.toLowerCase().startsWith('bearer ')) ACCESS_TOKEN = ACCESS_TOKEN.slice(7).trim();

  const API_URL = (process.env.MERCADOPAGO_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');
  const emailValido = (usuario.email && usuario.email.includes('@') && usuario.email.length > 5) ? usuario.email : `c${usuario.telefone.replace(/\D/g, '')}@email.com`;
  const cpfEnvio = gerarCpfValido();

  const body = {
    transaction_amount: Number(parseFloat(pedido.valor_total).toFixed(2)),
    description: `Pedido ${pedido.id} - Rifa`,
    payment_method_id: 'pix',
    payer: {
      email: emailValido,
      first_name: usuario.nome_completo ? usuario.nome_completo.split(' ')[0] : 'Cliente',
      last_name: 'Rifa',
      identification: { type: 'CPF', number: cpfEnvio }
    },
    external_reference: String(pedido.id)
  };

  try {
    const resp = await fetch(`${API_URL}/v1/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'X-Idempotency-Key': `ped_${pedido.id}_${Date.now()}` },
      body: JSON.stringify(body)
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.id && data.point_of_interaction?.transaction_data?.qr_code) {
      return { gateway_payment_id: String(data.id), pix_copia_cola: data.point_of_interaction.transaction_data.qr_code, pix_qr_code_base64: data.point_of_interaction.transaction_data.qr_code_base64 || '', provider: 'mercadopago' };
    }
    return null;
  } catch (err) { console.error('❌ Erro Conexão MP:', err.message); return null; }
}

async function criarPagamentoPay2M(pedido) {
  const cfg = await fetchConfigFromDB();
  const clientId = cfg.PAY2M_CLIENT_ID;
  const clientSecret = cfg.PAY2M_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    // ⚠️ Endpoint ilustrativo — confirme o path exato na documentação do Pay2M e ajuste aqui.
    const resp = await fetch('https://api.pay2m.com.br/v1/pix/qrcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': clientId, 'x-client-secret': clientSecret },
      body: JSON.stringify({ amount: Number(parseFloat(pedido.valor_total).toFixed(2)), description: `Pedido ${pedido.id}` })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const pix = data.pix || data;
    if (!pix) return null;
    return { gateway_payment_id: String(data.id || pix.id || ''), pix_copia_cola: pix.payload || pix.qrcode || '', pix_qr_code_base64: pix.qr_code_base64 || '', provider: 'pay2m' };
  } catch (err) { console.error('❌ Erro Conexão Pay2M:', err.message); return null; }
}

async function criarPagamentoPaggue(pedido) {
  const cfg = await fetchConfigFromDB();
  const token = cfg.PAGGUE_ACCESS_TOKEN;
  if (!token) return null;
  try {
    // ⚠️ Endpoint ilustrativo — confirme o path exato na documentação da Paggue e ajuste aqui.
    const resp = await fetch('https://api.paggue.io/v1/pix/charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: Number(parseFloat(pedido.valor_total).toFixed(2)), description: `Pedido ${pedido.id}` })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { gateway_payment_id: String(data.id || ''), pix_copia_cola: data.qr_code || data.payload || '', pix_qr_code_base64: data.qr_code_base64 || '', provider: 'paggue' };
  } catch (err) { console.error('❌ Erro Conexão Paggue:', err.message); return null; }
}

async function criarPagamentoGateway(pedido, usuario) {
  const cfg = await fetchConfigFromDB();
  const provider = (cfg.GATEWAY_PROVIDER || 'mercadopago').toLowerCase();

  let resultado = null;
  if (provider === 'pay2m') resultado = await criarPagamentoPay2M(pedido);
  else if (provider === 'paggue') resultado = await criarPagamentoPaggue(pedido);
  else resultado = await criarPagamentoMercadoPago(pedido, usuario);

  if (resultado) return resultado;

  // Fallback: se o provedor escolhido falhar (ou não estiver configurado), gera um PIX de teste
  // pra não travar o fluxo — mas isso NÃO é um pagamento real, é só pra você testar o layout.
  console.warn(`⚠️ Gateway "${provider}" não retornou pagamento — usando PIX de teste (mock).`);
  return { gateway_payment_id: uuidv4(), pix_copia_cola: `00020126580014BR.GOV.BCB.PIX0136${uuidv4()}5204000053039865802BR5913RIFA SYSTEM6008BRASILIA62070503***6304`, pix_qr_code_base64: '', provider: 'mock' };
}

// --- GERAÇÃO DE COTAS (com padCota e suporte a bônus de funil) ---

async function gerarCotasUnicas(pedido) {
  try {
    const { sorteio_id } = pedido;
    let user_id = pedido.user_id;

    if (!user_id) {
      const { data: pedFull } = await supabase.from('pedidos').select('user_id').eq('id', pedido.id).maybeSingle();
      if (pedFull?.user_id) user_id = pedFull.user_id;
      else return [];
    }

    const { data: sorteio } = await supabase.from('sorteios').select('total_cotas').eq('id', sorteio_id).maybeSingle();
    if (!sorteio) return [];

    // Bônus de cotas grátis do funil (se o pedido veio de um funil com bonificação)
    let bonusCotas = 0;
    if (pedido.funil_id) {
      const { data: funil } = await supabase.from('funis').select('bonus_cotas_extra').eq('id', pedido.funil_id).maybeSingle();
      bonusCotas = Number(funil?.bonus_cotas_extra || 0);
    }

    // Chance em Dobro: se o pedido foi feito dentro de uma janela ativa, dobra a quantidade de cotas
    try {
      const { data: chancesDobro } = await supabase.from('chance_dobro').select('*').eq('sorteio_id', sorteio_id).eq('ativo', true);
      const criadoEm = pedido.created_at || new Date().toISOString();
      const teveChanceDobro = (chancesDobro || []).some(c => criadoEm >= c.data_inicio && criadoEm <= c.data_fim);
      if (teveChanceDobro) bonusCotas += Number(pedido.quantidade_cotas || 0);
    } catch (err) { console.error('Erro ao checar chance em dobro', err); }

    const totalCotas = Number(sorteio.total_cotas) || 1000000;
    const nowISO = new Date().toISOString();

    const [bloqRes, agRes, vendRes] = await Promise.all([
      supabase.from('cotas_bloqueadas').select('numero_cota').eq('sorteio_id', sorteio_id),
      supabase.from('cotas_agendadas').select('numero_cota, release_at, liberar_em, condicao_tipo, condicao_quantidade').eq('sorteio_id', sorteio_id),
      supabase.from('cotas').select('numero_cota').eq('sorteio_id', sorteio_id)
    ]);

    const qtdPedidoAtual = Number(pedido.quantidade_cotas || 0);
    const agendadasAindaBloqueadas = (agRes.data || []).filter(r => {
      const dataLiberacao = r.release_at || r.liberar_em;
      const aindaNaoChegouADat = dataLiberacao && dataLiberacao > nowISO;
      if (aindaNaoChegouADat) return true; // data ainda não chegou — continua bloqueada pra todo mundo
      // Data já passou: se tiver condição de quantidade, só libera pra quem se encaixa nela
      if (r.condicao_tipo === 'acima' && !(qtdPedidoAtual > Number(r.condicao_quantidade))) return true;
      if (r.condicao_tipo === 'abaixo' && !(qtdPedidoAtual < Number(r.condicao_quantidade))) return true;
      return false; // liberada de vez pra esse pedido
    });

    const invalidos = new Set([
      ...(bloqRes.data || []).map(r => r.numero_cota),
      ...agendadasAindaBloqueadas.map(r => r.numero_cota),
      ...(vendRes.data || []).map(r => r.numero_cota)
    ]);

    const quantidade = Number(pedido.quantidade_cotas || 0) + bonusCotas;
    const rows = [];
    let attempts = 0;
    const maxAttempts = Math.max(quantidade * 200, 20000);

    while (rows.length < quantidade && attempts < maxAttempts) {
      attempts++;
      const numeroInt = Math.floor(Math.random() * totalCotas);
      const numero = padCota(numeroInt, totalCotas);

      if (!invalidos.has(numero) && !rows.some(r => r.numero_cota === numero)) {
        rows.push({ sorteio_id, pedido_id: pedido.id, user_id, numero_cota: numero, created_at: new Date().toISOString() });
        invalidos.add(numero);
      }
    }

    if (rows.length === 0) return [];

    // Insere em lote. Se colidir com outra cota já inserida por um pagamento aprovado ao mesmo tempo
    // (protegido por UNIQUE INDEX no banco — veja o SQL), insere uma por uma e troca só as que colidiram.
    let inserted = [];
    const { data: insertedBulk, error: bulkError } = await supabase.from('cotas').insert(rows).select('id, numero_cota');
    if (!bulkError && insertedBulk) {
      inserted = insertedBulk;
    } else {
      console.warn('⚠️ Conflito na inserção em lote (provável corrida entre pagamentos simultâneos). Tentando uma a uma...', bulkError?.message);
      for (const row of rows) {
        let tentativas = 0;
        let ok = false;
        let candidato = row;
        while (!ok && tentativas < 50) {
          tentativas++;
          const { data: ins, error: insErr } = await supabase.from('cotas').insert(candidato).select('id, numero_cota').single();
          if (!insErr && ins) { inserted.push(ins); ok = true; }
          else {
            // Colidiu (outra requisição pegou esse número primeiro) — sorteia outro e tenta de novo
            const novoNumero = padCota(Math.floor(Math.random() * totalCotas), totalCotas);
            candidato = { ...candidato, numero_cota: novoNumero };
          }
        }
      }
    }
    if (inserted.length === 0) return [];

    await safeUpdatePedidos(pedido.id, { cotas_geradas: 1, cotas_array: inserted.map(r => r.numero_cota), status: 'pago', updated_at: new Date().toISOString() });

    // Verifica se alguma das cotas geradas bate com um BILHETE premiado ainda disponível
    // (a roleta usa números de cota reais também, mas é tratada à parte — veja atribuirGirosRoleta).
    const numeros = inserted.map(r => r.numero_cota);
    try {
      const { data: possiveisPremios } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', sorteio_id).eq('tipo', 'bilhete').eq('status', 'disponivel').eq('ativo', true).in('numero_cota', numeros);
      for (const premio of (possiveisPremios || [])) {
        await supabase.from('bilhetes_premiados').update({
          status: 'reivindicada', usuario_id: user_id, pedido_id: pedido.id, reivindicada_em: new Date().toISOString()
        }).eq('id', premio.id);
      }
    } catch (err) { console.error('Erro ao vincular bilhete premiado', err); }

    // Roleta: se estiver ativada, calcula quantos giros esse pedido ganhou (pela faixa de cotas
    // compradas) e verifica se alguma das cotas reais geradas bate com um prêmio de roleta escondido.
    try { await atribuirGirosRoleta(sorteio_id, pedido, user_id, numeros); } catch (err) { console.error('Erro ao atribuir giros de roleta', err); }

    return inserted;

  } catch (err) { console.error('❌ Erro gerarCotasUnicas:', err); return []; }
}

// Calcula quantos giros de roleta um pedido ganhou (pela faixa de cotas compradas) e sorteia
// números de giro únicos dentro do pool da roleta desse sorteio, verificando prêmios na hora.
// Calcula quantos giros de roleta um pedido ganhou (pela faixa de cotas compradas), verifica se
// alguma das cotas REAIS geradas pra esse pedido bate com um prêmio de roleta escondido, e monta
// os giros desse pedido (um deles "premiado" se houve acerto, os demais "Tente Denovo").
//
// Importante: a roleta é, por trás dos panos, igual ao bilhete premiado — um número de cota real
// e escondido. A diferença é só que, se a cota premiada sair pra alguém que não tem giro de roleta
// disponível (comprou pouco, ou nunca gira), a premiação não se perde: o sistema troca esse prêmio
// pra outro número de cota que ainda não foi vendido, pra continuar valendo pra um comprador futuro.
async function atribuirGirosRoleta(sorteio_id, pedido, user_id, numerosGerados) {
  const { data: sorteio } = await supabase.from('sorteios').select('roleta_ativada, total_cotas, roleta_giros_por_compra').eq('id', sorteio_id).maybeSingle();
  if (!sorteio || !sorteio.roleta_ativada) return;

  const girosGarantidos = Number(sorteio.roleta_giros_por_compra ?? 1);
  let qtdGiros = girosGarantidos;

  // Os combos de "a cada X títulos, receba Y roletas" só valem quando o cliente comprou de novo
  // clicando especificamente num combo (mostrado na tela da roleta) — nunca automaticamente em
  // qualquer compra que "bata" com a quantidade. Compra normal (mesmo grande) = só o padrão.
  if (pedido.veio_de_combo_roleta) {
    const { data: tiers } = await supabase.from('roleta_tiers').select('*').eq('sorteio_id', sorteio_id).order('minimo_cotas', { ascending: false });
    const qtdComprada = Number(pedido.quantidade_cotas || 0);
    const tierAlcançado = (tiers || []).find(t => qtdComprada >= Number(t.minimo_cotas));
    if (tierAlcançado) qtdGiros = Math.max(girosGarantidos, Number(tierAlcançado.quantidade_giros));
  }

  // Verifica se alguma das cotas REAIS geradas agora bate com um prêmio de roleta ainda disponível
  const { data: premiosRoleta } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', sorteio_id).eq('tipo', 'roleta').eq('status', 'disponivel').in('numero_cota', numerosGerados);
  const premioAcertado = (premiosRoleta || [])[0] || null;

  if (premioAcertado) {
    if (qtdGiros > 0) {
      // Tem giro disponível: confirma o prêmio pra esse comprador
      await supabase.from('bilhetes_premiados').update({
        status: 'reivindicada', usuario_id: user_id, pedido_id: pedido.id, reivindicada_em: new Date().toISOString()
      }).eq('id', premioAcertado.id).eq('status', 'disponivel');
    } else {
      // Comprou uma cota premiada da roleta mas não tem giro pra usar — reatribui esse prêmio
      // pra um número de cota que ainda não foi vendido, pra não se perder.
      try {
        const totalCotas = Number(sorteio.total_cotas) || 1000000;
        const { data: vendidas } = await supabase.from('cotas').select('numero_cota').eq('sorteio_id', sorteio_id);
        const { data: outrosPremios } = await supabase.from('bilhetes_premiados').select('numero_cota').eq('sorteio_id', sorteio_id);
        const ocupados = new Set([...(vendidas || []).map(r => r.numero_cota), ...(outrosPremios || []).map(r => r.numero_cota)]);
        let novoNumero = null, tentativas = 0;
        while (!novoNumero && tentativas < 500) {
          tentativas++;
          const candidato = padCota(Math.floor(Math.random() * totalCotas), totalCotas);
          if (!ocupados.has(candidato)) novoNumero = candidato;
        }
        if (novoNumero) await supabase.from('bilhetes_premiados').update({ numero_cota: novoNumero }).eq('id', premioAcertado.id);
      } catch (err) { console.error('Erro ao reatribuir prêmio de roleta', err); }
    }
  }

  if (qtdGiros <= 0) return;

  const houveVitoria = premioAcertado && qtdGiros > 0;
  const novasLinhas = [];
  for (let i = 0; i < qtdGiros; i++) {
    const éOGiroVencedor = houveVitoria && i === 0;
    novasLinhas.push({
      sorteio_id, pedido_id: pedido.id, usuario_id: user_id,
      numero_giro: i + 1,
      premio_titulo: éOGiroVencedor ? premioAcertado.premio_titulo : null,
      valor_premio: éOGiroVencedor ? premioAcertado.valor_premio : null,
      bilhete_premiado_id: éOGiroVencedor ? premioAcertado.id : null,
      girado: false, created_at: new Date().toISOString()
    });
  }
  await supabase.from('roleta_giros').insert(novasLinhas);
}

// --- API PEDIDOS PUBLIC (com suporte a funil_id) ---
app.post('/api/public/pedidos/iniciar', async (req, res) => {
  try {
    const { sorteio_id, quantidade, nome_completo, telefone, email, cpf, endereco, funil_id, link_codigo, veio_de_combo_roleta } = req.body || {};
    if (!sorteio_id || !quantidade || !telefone) return res.status(400).json({ error: 'Dados incompletos' });

    const telefoneLimpo = String(telefone).replace(/\D/g, '');
    const cpfLimpo = cpf ? String(cpf).replace(/\D/g, '') : null;
    const { data: usuarioExistente } = await supabase.from('usuarios').select('*').eq('telefone', telefoneLimpo).maybeSingle();
    let usuario = usuarioExistente;
    if (!usuario) {
      if (!nome_completo) return res.status(400).json({ error: 'Nome é obrigatório para novos compradores' });
      const { data: novo, error: nErr } = await supabase.from('usuarios').insert({ nome_completo, telefone: telefoneLimpo, email, cpf: cpfLimpo, endereco }).select().single();
      if (nErr) return fail(res, 'Erro ao criar usuário');
      usuario = novo;
    } else {
      // Atualiza dados novos (ex: CPF/email/endereço) se o comprador já existia mas não tinha isso salvo ainda
      const atualizacao = {};
      if (email && !usuario.email) atualizacao.email = email;
      if (cpfLimpo && !usuario.cpf) atualizacao.cpf = cpfLimpo;
      if (endereco && !usuario.endereco) atualizacao.endereco = endereco;
      if (Object.keys(atualizacao).length > 0) {
        const { data: atualizado } = await supabase.from('usuarios').update(atualizacao).eq('id', usuario.id).select().single();
        if (atualizado) usuario = atualizado;
      }
    }

    const { data: sorteio } = await supabase.from('sorteios').select('*').eq('id', sorteio_id).maybeSingle();
    if (!sorteio) return res.status(404).json({ error: 'Sorteio não encontrado' });

    if (sorteio.minimo_cotas_compra && quantidade < sorteio.minimo_cotas_compra) return res.status(400).json({ error: `Mínimo: ${sorteio.minimo_cotas_compra}` });
    if (sorteio.maximo_cotas_compra && quantidade > sorteio.maximo_cotas_compra) return res.status(400).json({ error: `Máximo: ${sorteio.maximo_cotas_compra}` });
    if (sorteio.coletar_cpf && !usuario.cpf) return res.status(400).json({ error: 'CPF é obrigatório para este sorteio' });
    if (sorteio.coletar_email && !usuario.email) return res.status(400).json({ error: 'Email é obrigatório para este sorteio' });
    if (sorteio.coletar_endereco && !usuario.endereco) return res.status(400).json({ error: 'Endereço é obrigatório para este sorteio' });

    let valor_total = Number(sorteio.preco_cota) * Number(quantidade);
    let promocao_aplicada = null;
    const { data: promoMatch } = await supabase.from('promocoes').select('*').eq('sorteio_id', sorteio_id).eq('ativo', true).eq('quantidade_cotas', quantidade).maybeSingle();
    if (promoMatch) {
      valor_total = Number(promoMatch.preco_promocional);
      promocao_aplicada = promoMatch.titulo;
    }
    const token = uuidv4();
    const expira = new Date(Date.now() + (Number(sorteio.tempo_pagamento || 15) * 60000)).toISOString();

    // Valida que o funil (se informado) pertence a este sorteio
    let funilValido = null;
    if (funil_id) {
      const { data: f } = await supabase.from('funis').select('id').eq('id', funil_id).eq('sorteio_id', sorteio_id).maybeSingle();
      funilValido = f?.id || null;
    }

    let link_id = null;
    if (link_codigo) {
      const { data: link } = await supabase.from('links_rastreamento').select('id').eq('sorteio_id', sorteio_id).eq('codigo', link_codigo).maybeSingle();
      link_id = link?.id || null;
    }

    const { data: pedido } = await supabase.from('pedidos').insert({
      token, user_id: usuario.id, sorteio_id, quantidade_cotas: quantidade, valor_total, status: 'aguardando', expira_em: expira, funil_id: funilValido, link_id, promocao_titulo: promocao_aplicada, veio_de_combo_roleta: !!veio_de_combo_roleta, created_at: new Date().toISOString()
    }).select().single();

    const pagamento = await criarPagamentoGateway(pedido, usuario);
    await supabase.from('pedidos').update({
      gateway_payment_id: pagamento.gateway_payment_id,
      pix_copia_cola: pagamento.pix_copia_cola || null,
      pix_qr_code_base64: pagamento.pix_qr_code_base64 || null,
      payment_provider: pagamento.provider || null,
      updated_at: new Date().toISOString()
    }).eq('id', pedido.id);

    return ok(res, {
      token,
      redirect: `/checkout/${token}`,
      payment: pagamento,
      pixel_data: { value: valor_total, currency: 'BRL', num_items: quantidade },
      pedido: {
        ...pedido,
        pix_copia_cola: pagamento.pix_copia_cola || null,
        pix_qr_code_base64: pagamento.pix_qr_code_base64 || null
      }
    });
  } catch (err) { console.error('POST /api/public/pedidos/iniciar', err); return fail(res); }
});

app.get('/api/public/pedidos/:token/status', async (req, res) => {
  try {
    const { token } = req.params;
    let { data: pedido } = await supabase.from('pedidos').select('*, sorteios(*), usuarios(*)').eq('token', token).maybeSingle();
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });

    // Auto Aprovação
    if (pedido.status !== 'pago' && pedido.gateway_payment_id && pedido.payment_provider === 'mercadopago') {
      const cfg = await fetchConfigFromDB();
      const MP_TOKEN = (MP_ACCESS_TOKEN_FIXO && MP_ACCESS_TOKEN_FIXO.length > 20) ? MP_ACCESS_TOKEN_FIXO : (cfg.MERCADOPAGO_ACCESS_TOKEN || process.env.MERCADOPAGO_ACCESS_TOKEN);
      if (MP_TOKEN) {
        try {
          const resp = await fetch(`https://api.mercadopago.com/v1/payments/${pedido.gateway_payment_id}`, { headers: { Authorization: `Bearer ${MP_TOKEN.trim()}` } });
          if (resp.ok) {
            const info = await resp.json();
            if (info.status === 'approved' && (info.status_detail === 'accredited' || info.status_detail === 'approved')) {
              await gerarCotasUnicas(pedido);
              const { data: updated } = await supabase.from('pedidos').select('*, sorteios(*), usuarios(*)').eq('id', pedido.id).single();
              pedido = updated;
            }
          }
        } catch (e) { console.error('Erro verificando MP:', e); }
      }
    }

    let derived_status = 'pendente';
    const now = Date.now();
    if (pedido.status === 'pago') derived_status = 'aprovado';
    else if (pedido.expira_em && new Date(pedido.expira_em).getTime() < now) derived_status = 'expirado';
    const statusCode = derived_status === 'aprovado' ? '2' : (derived_status === 'expirado' ? '0' : '1');

    let funil = null;
    if (pedido.funil_id) {
      const { data: f } = await supabase.from('funis').select('*').eq('id', pedido.funil_id).maybeSingle();
      funil = f || null;
    }

    return ok(res, {
      status: statusCode, derived_status, cotas: pedido.cotas_array || [],
      link_grupo_vip: pedido.sorteios?.link_grupo_vip,
      payment: { gateway_payment_id: pedido.gateway_payment_id, pix_copia_cola: pedido.pix_copia_cola, pix_qr_code_base64: pedido.pix_qr_code_base64, provider: pedido.payment_provider },
      pixel_data: { value: pedido.valor_total, currency: 'BRL', num_items: pedido.quantidade_cotas, sorteio_nome: pedido.sorteios?.nome },
      funil
    });
  } catch (err) { console.error(err); return fail(res); }
});

// ==================================================================
// 🧩 FUNIS — múltiplos sites/funis dentro de um mesmo sorteio
// ==================================================================

app.get('/api/admin/sorteios/:id/funis', ensureAdminAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('funis').select('*').eq('sorteio_id', req.params.id).order('created_at', { ascending: false });
    if (error) return fail(res, error.message);
    return ok(res, { funis: data || [] });
  } catch (e) { return fail(res); }
});

app.post('/api/admin/sorteios/:id/funis', ensureAdminAuth, async (req, res) => {
  try {
    const sorteio_id = req.params.id;
    const body = req.body || {};
    if (!body.nome) return fail(res, 'Nome do funil é obrigatório', 400);

    let slug = (body.slug || body.nome).toString().toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const { data: exists } = await supabase.from('funis').select('id').eq('sorteio_id', sorteio_id).eq('slug', slug).limit(1);
    if (exists && exists.length > 0) slug = `${slug}-${Date.now()}`;

    const payload = {
      sorteio_id,
      nome: body.nome,
      slug,
      origem: body.origem || 'ads', // 'ads' | 'organico' | 'outro' — apenas organizacional
      pos_pagamento_tipo: body.pos_pagamento_tipo === 'bonus' ? 'bonus' : 'padrao',
      pos_pagamento_titulo: body.pos_pagamento_titulo || null,
      pos_pagamento_mensagem: body.pos_pagamento_mensagem || null,
      bonus_cotas_extra: parseInt(body.bonus_cotas_extra || 0) || 0,
      arquivo_html: body.arquivo_html || 'sorteio.html', // qual HTML em public/funis/ esse funil usa (página inicial do sorteio)
      arquivo_checkout_html: body.arquivo_checkout_html || 'checkout.html', // qual HTML em public/funis/ esse funil usa NO CHECKOUT (pós-pagamento, upsell, etc.)
      grupo_teste: body.grupo_teste || null,             // funis com o mesmo grupo_teste disputam tráfego (A/B)
      peso_trafego: parseInt(body.peso_trafego || 100) || 100,
      ativo: body.ativo === false || body.ativo === 'false' ? false : true,
      created_at: new Date().toISOString()
    };

    const { data: inserted, error } = await supabase.from('funis').insert(payload).select().single();
    if (error) return fail(res, error.message);

    // Cria automaticamente um link de rastreamento pra esse funil, já com 0 acessos,
    // pra ele aparecer em Comparativo de Links mesmo antes de qualquer visita.
    try {
      await supabase.from('links_rastreamento').insert({
        sorteio_id, funil_id: inserted.id, nome: `Funil: ${inserted.nome}`,
        codigo: `funil-${slug}`, canal: inserted.origem === 'ads' ? 'facebook_ads' : (inserted.origem === 'organico' ? 'instagram_organico' : 'outro'),
        cliques: 0, created_at: new Date().toISOString()
      });
    } catch (err) { console.error('Erro ao criar link automático do funil', err); }

    return ok(res, { funil: inserted });
  } catch (e) { console.error('POST funis', e); return fail(res); }
});

app.put('/api/admin/funis/:id', ensureAdminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {};
    ['nome', 'origem', 'pos_pagamento_titulo', 'pos_pagamento_mensagem', 'arquivo_html', 'arquivo_checkout_html', 'grupo_teste'].forEach(k => { if (body[k] !== undefined) payload[k] = body[k]; });
    if (body.pos_pagamento_tipo !== undefined) payload.pos_pagamento_tipo = body.pos_pagamento_tipo === 'bonus' ? 'bonus' : 'padrao';
    if (body.bonus_cotas_extra !== undefined) payload.bonus_cotas_extra = parseInt(body.bonus_cotas_extra || 0) || 0;
    if (body.peso_trafego !== undefined) payload.peso_trafego = parseInt(body.peso_trafego || 100) || 100;
    if (body.ativo !== undefined) payload.ativo = body.ativo === true || body.ativo === 'true';

    const { data, error } = await supabase.from('funis').update(payload).eq('id', req.params.id).select().single();
    if (error) return fail(res, error.message);
    return ok(res, { funil: data });
  } catch (e) { return fail(res); }
});

app.delete('/api/admin/funis/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('funis').delete().eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});

// ==================================================================
// 🔗 LINKS DE RASTREAMENTO (manuais + detecção automática)
// ==================================================================

app.get('/api/admin/sorteios/:id/links', ensureAdminAuth, async (req, res) => {
  try {
    const sorteio_id = req.params.id;
    const { data: links } = await supabase.from('links_rastreamento').select('*, funis(nome, slug)').eq('sorteio_id', sorteio_id).order('cliques', { ascending: false });
    const { data: sorteio } = await supabase.from('sorteios').select('slug').eq('id', sorteio_id).maybeSingle();

    const resultados = [];
    for (const link of (links || [])) {
      const { data: pedidos } = await supabase.from('pedidos').select('valor_total, status, expira_em').eq('link_id', link.id);
      const nowISOLink = new Date().toISOString();
      const pagos = (pedidos || []).filter(p => p.status === 'pago');
      const pendentes = (pedidos || []).filter(p => p.status === 'aguardando' && (!p.expira_em || p.expira_em >= nowISOLink));
      const faturamento = pagos.reduce((s, p) => s + Number(p.valor_total || 0), 0);
      const pendente = pendentes.reduce((s, p) => s + Number(p.valor_total || 0), 0);
      const total_pedidos = (pedidos || []).length;
      const ticket_medio = pagos.length > 0 ? faturamento / pagos.length : 0;
      const conversao = link.cliques > 0 ? (pagos.length / link.cliques) * 100 : 0;
      const caminho = link.funis?.slug ? `/sorteio/${sorteio?.slug || ''}/${link.funis.slug}` : `/sorteio/${sorteio?.slug || ''}`;
      resultados.push({
        ...link,
        url: link.codigo.startsWith('auto-') ? null : `${req.protocol}://${req.get('host')}${caminho}?lk=${link.codigo}`,
        cliques: link.cliques || 0,
        pedidos_pagos: pagos.length,
        total_pedidos,
        faturamento,
        pendente,
        ticket_medio,
        conversao
      });
    }
    return ok(res, { links: resultados });
  } catch (e) { console.error('GET links', e); return fail(res); }
});

app.post('/api/admin/sorteios/:id/links', ensureAdminAuth, async (req, res) => {
  try {
    const sorteio_id = req.params.id;
    const { nome, canal, funil_id } = req.body || {};
    if (!nome) return fail(res, 'Nome do link é obrigatório', 400);
    let codigo = nome.toString().toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const { data: exists } = await supabase.from('links_rastreamento').select('id').eq('sorteio_id', sorteio_id).eq('codigo', codigo).limit(1);
    if (exists && exists.length > 0) codigo = `${codigo}-${Date.now()}`;

    const { data: inserted, error } = await supabase.from('links_rastreamento').insert({
      sorteio_id, nome, codigo, canal: canal || 'outro', funil_id: funil_id || null, cliques: 0, created_at: new Date().toISOString()
    }).select().single();
    if (error) return fail(res, error.message);
    return ok(res, { link: inserted });
  } catch (e) { console.error('POST links', e); return fail(res); }
});

app.delete('/api/admin/links/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('links_rastreamento').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

// Comparativo geral de links (todos os sorteios, ou filtrado por ?sorteio_id=)
app.get('/api/admin/links/comparativo', ensureAdminAuth, async (req, res) => {
  try {
    const { sorteio_id, start_date, end_date } = req.query;
    let q = supabase.from('links_rastreamento').select('*, sorteios(nome, slug)');
    if (sorteio_id && sorteio_id !== 'todos') q = q.eq('sorteio_id', sorteio_id);
    const { data: links } = await q.order('cliques', { ascending: false });

    const resultados = [];
    for (const link of (links || [])) {
      let acessosQ = supabase.from('acessos_log').select('*', { head: true, count: 'exact' }).eq('link_id', link.id);
      let pedidosQ = supabase.from('pedidos').select('valor_total, status').eq('link_id', link.id);
      if (start_date) { acessosQ = acessosQ.gte('created_at', start_date); pedidosQ = pedidosQ.gte('created_at', start_date); }
      if (end_date) { acessosQ = acessosQ.lte('created_at', end_date); pedidosQ = pedidosQ.lte('created_at', end_date); }

      const filtrandoPeriodo = !!(start_date || end_date);
      const { count: acessosPeriodo } = await acessosQ;
      const { data: pedidos } = await pedidosQ;

      const cliques = filtrandoPeriodo ? (acessosPeriodo || 0) : (link.cliques || 0);
      const pagos = (pedidos || []).filter(p => p.status === 'pago');
      const nowISO = new Date().toISOString();
      const expirados = (pedidos || []).filter(p => p.status === 'aguardando' && p.expira_em && p.expira_em < nowISO).length;
      const faturamento = pagos.reduce((s, p) => s + Number(p.valor_total || 0), 0);
      const pendente = (pedidos || []).filter(p => p.status === 'aguardando' && (!p.expira_em || p.expira_em >= nowISO)).reduce((s, p) => s + Number(p.valor_total || 0), 0);
      const ticket_medio = pagos.length > 0 ? faturamento / pagos.length : 0;
      const conversao = cliques > 0 ? (pagos.length / cliques) * 100 : 0;
      // Link oficial (auto-direto do sorteio, sem funil) tem URL limpa; links criados manualmente usam ?lk=
      let url = null;
      const slug = link.sorteios?.slug;
      if (slug) {
        if (link.codigo === 'auto-direto') url = `${req.protocol}://${req.get('host')}/sorteio/${slug}`;
        else if (!link.codigo.startsWith('auto-')) url = `${req.protocol}://${req.get('host')}/sorteio/${slug}?lk=${link.codigo}`;
      }
      resultados.push({ ...link, url, cliques, pedidos_pagos: pagos.length, expirados, faturamento, pendente, ticket_medio, conversao });
    }
    return ok(res, { links: resultados });
  } catch (e) { console.error('GET comparativo', e); return fail(res); }
});

// Detalhe de um link específico: métricas + série diária de acessos/faturamento (pra gráfico)
app.get('/api/admin/links/:id/detalhe', ensureAdminAuth, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const { data: link } = await supabase.from('links_rastreamento').select('*, sorteios(nome, slug)').eq('id', req.params.id).maybeSingle();
    if (!link) return fail(res, 'Link não encontrado', 404);

    let acessosQ = supabase.from('acessos_log').select('created_at').eq('link_id', link.id);
    let pedidosQ = supabase.from('pedidos').select('valor_total, status, created_at, expira_em').eq('link_id', link.id);
    if (start_date) { acessosQ = acessosQ.gte('created_at', start_date); pedidosQ = pedidosQ.gte('created_at', start_date); }
    if (end_date) { acessosQ = acessosQ.lte('created_at', end_date); pedidosQ = pedidosQ.lte('created_at', end_date); }
    const { data: acessos } = await acessosQ;
    const { data: pedidos } = await pedidosQ;

    const porDia = {};
    (acessos || []).forEach(a => {
      const k = (a.created_at || '').slice(0, 10);
      if (!porDia[k]) porDia[k] = { dia: k, acessos: 0, faturamento: 0 };
      porDia[k].acessos++;
    });
    const nowISO = new Date().toISOString();
    const pagos = (pedidos || []).filter(p => p.status === 'pago');
    const pendentes = (pedidos || []).filter(p => p.status === 'aguardando' && (!p.expira_em || p.expira_em >= nowISO));
    const expirados = (pedidos || []).filter(p => p.status === 'aguardando' && p.expira_em && p.expira_em < nowISO);
    pagos.forEach(p => {
      const k = (p.created_at || '').slice(0, 10);
      if (!porDia[k]) porDia[k] = { dia: k, acessos: 0, faturamento: 0 };
      porDia[k].faturamento += Number(p.valor_total || 0);
    });
    const serie = Object.values(porDia).sort((a, b) => a.dia.localeCompare(b.dia));

    const faturamento = pagos.reduce((s, p) => s + Number(p.valor_total || 0), 0);
    const pendente = pendentes.reduce((s, p) => s + Number(p.valor_total || 0), 0);
    const totalAcessos = (acessos || []).length || link.cliques || 0;

    return ok(res, {
      link, serie,
      acessos: totalAcessos, pedidos_pagos: pagos.length, pendentes: pendentes.length, expirados: expirados.length,
      faturamento, pendente, ticket_medio: pagos.length > 0 ? faturamento / pagos.length : 0,
      conversao: totalAcessos > 0 ? (pagos.length / totalAcessos) * 100 : 0
    });
  } catch (e) { console.error('GET link detalhe', e); return fail(res); }
});

// ==================================================================
// 🎡 ROLETA (mesma mecânica de bilhete premiado, com tipo='roleta' e sem exibir o número)
// ==================================================================

app.get('/api/admin/sorteios/:id/roleta', ensureAdminAuth, async (req, res) => {
  try {
    await sincronizarBilhetesComCotasVendidas(req.params.id);
    const { data } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', req.params.id).eq('tipo', 'roleta').order('created_at', { ascending: true });
    const itens = data || [];
    const usuarioIds = [...new Set(itens.map(b => b.usuario_id).filter(Boolean))];
    const { data: usuarios } = usuarioIds.length ? await supabase.from('usuarios').select('*').in('id', usuarioIds) : { data: [] };
    const usuarioMap = (usuarios || []).reduce((a, u) => (a[u.id] = u, a), {});
    const enriquecidos = itens.map(b => ({ ...b, ganhador_nome: usuarioMap[b.usuario_id]?.nome_completo || b.nome_completo || null }));
    return ok(res, { roleta: enriquecidos });
  } catch (e) { return fail(res); }
});

app.post('/api/admin/sorteios/:id/roleta', ensureAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { numero_cota, premio_titulo, valor_premio } = req.body || {};
    const { data: sorteioRef } = await supabase.from('sorteios').select('total_cotas').eq('id', id).maybeSingle();
    const numeroFormatado = padCota(String(numero_cota).replace(/\D/g, ''), sorteioRef?.total_cotas);

    const { data: cotaVendida } = await supabase.from('cotas').select('user_id, pedido_id').eq('sorteio_id', id).eq('numero_cota', numeroFormatado).maybeSingle();
    const payload = { sorteio_id: id, numero_cota: numeroFormatado, premio_titulo, valor_premio: valor_premio || null, tipo: 'roleta' };
    if (cotaVendida) {
      payload.status = 'reivindicada';
      payload.usuario_id = cotaVendida.user_id || null;
      payload.pedido_id = cotaVendida.pedido_id || null;
      payload.reivindicada_em = new Date().toISOString();
    } else {
      payload.status = 'disponivel';
    }

    const { data, error } = await supabase.from('bilhetes_premiados').insert(payload).select().single();
    if (error) return fail(res, error.message);
    return ok(res, data);
  } catch (e) { return fail(res); }
});

// Resultados da roleta: SEM o número da cota — só título, valor e o ganhador (quando já saiu)
app.get('/api/admin/sorteios/:id/roleta/resultados', ensureAdminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', req.params.id).eq('tipo', 'roleta').order('reivindicada_em', { ascending: false });
    const todos = data || [];
    const disponiveis = todos.filter(b => b.status === 'disponivel');
    const ganhas = todos.filter(b => b.status === 'reivindicada');

    const usuarioIds = [...new Set(ganhas.map(g => g.usuario_id).filter(Boolean))];
    const { data: usuarios } = usuarioIds.length ? await supabase.from('usuarios').select('*').in('id', usuarioIds) : { data: [] };
    const usuarioMap = (usuarios || []).reduce((a, u) => (a[u.id] = u, a), {});

    const ganhadores = ganhas.map(g => ({
      id: g.id, premio_titulo: g.premio_titulo, valor_premio: g.valor_premio, reivindicada_em: g.reivindicada_em,
      usuario: usuarioMap[g.usuario_id] || null
    }));

    return ok(res, { disponiveis: disponiveis.length, ganhadores });
  } catch (e) { console.error('GET roleta/resultados', e); return fail(res); }
});

// Faixas de giros: "a cada X títulos comprados, ganha Y giros de roleta"
app.get('/api/admin/sorteios/:id/roleta-tiers', ensureAdminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('roleta_tiers').select('*').eq('sorteio_id', req.params.id).order('minimo_cotas', { ascending: true });
    return ok(res, { tiers: data || [] });
  } catch (e) { return fail(res); }
});

// ==================================================================
// ⚡ CHANCE EM DOBRO — dobra as cotas de quem comprar numa janela de tempo
// ==================================================================
app.get('/api/admin/sorteios/:id/chance-dobro', ensureAdminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('chance_dobro').select('*').eq('sorteio_id', req.params.id).order('data_inicio', { ascending: false });
    return ok(res, { lista: data || [] });
  } catch (e) { return fail(res); }
});
app.post('/api/admin/sorteios/:id/chance-dobro', ensureAdminAuth, async (req, res) => {
  try {
    const { titulo, data_inicio, data_fim, ativo } = req.body || {};
    if (!data_inicio || !data_fim) return fail(res, 'Preencha o início e o fim do período', 400);
    const { data, error } = await supabase.from('chance_dobro').insert({
      sorteio_id: req.params.id, titulo: titulo || 'Chance em Dobro',
      data_inicio: new Date(data_inicio).toISOString(), data_fim: new Date(data_fim).toISOString(),
      ativo: ativo !== false
    }).select().single();
    if (error) return fail(res, error.message);
    return ok(res, { chance: data });
  } catch (e) { return fail(res); }
});
app.put('/api/admin/chance-dobro/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { ativo, titulo, data_inicio, data_fim } = req.body || {};
    const payload = {};
    if (ativo !== undefined) payload.ativo = !!ativo;
    if (titulo !== undefined) payload.titulo = titulo;
    if (data_inicio) payload.data_inicio = new Date(data_inicio).toISOString();
    if (data_fim) payload.data_fim = new Date(data_fim).toISOString();
    const { error } = await supabase.from('chance_dobro').update(payload).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/chance-dobro/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('chance_dobro').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

// ==================================================================
// 🚨 AVISOS DE URGÊNCIA — banners com contagem regressiva (pode ter vários por sorteio)
// ==================================================================
app.get('/api/admin/sorteios/:id/avisos-urgencia', ensureAdminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('avisos_urgencia').select('*').eq('sorteio_id', req.params.id).order('data_inicio', { ascending: false });
    return ok(res, { lista: data || [] });
  } catch (e) { return fail(res); }
});
app.post('/api/admin/sorteios/:id/avisos-urgencia', ensureAdminAuth, async (req, res) => {
  try {
    const { titulo, descricao, data_inicio, data_fim, ativo } = req.body || {};
    if (!data_inicio || !data_fim) return fail(res, 'Preencha o início e o fim do período', 400);
    const { data, error } = await supabase.from('avisos_urgencia').insert({
      sorteio_id: req.params.id, titulo: titulo || '🚨 CORRE QUE ESTÁ ACABANDO 🚨', descricao: descricao || null,
      data_inicio: new Date(data_inicio).toISOString(), data_fim: new Date(data_fim).toISOString(),
      ativo: ativo !== false
    }).select().single();
    if (error) return fail(res, error.message);
    return ok(res, { aviso: data });
  } catch (e) { return fail(res); }
});
app.put('/api/admin/avisos-urgencia/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { ativo, titulo, descricao, data_inicio, data_fim } = req.body || {};
    const payload = {};
    if (ativo !== undefined) payload.ativo = !!ativo;
    if (titulo !== undefined) payload.titulo = titulo;
    if (descricao !== undefined) payload.descricao = descricao;
    if (data_inicio) payload.data_inicio = new Date(data_inicio).toISOString();
    if (data_fim) payload.data_fim = new Date(data_fim).toISOString();
    const { error } = await supabase.from('avisos_urgencia').update(payload).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/avisos-urgencia/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('avisos_urgencia').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

// ==================================================================
// 🏷️ PROMOÇÕES — combos com desconto (ex: "300 títulos por R$10")
// ==================================================================
app.get('/api/admin/sorteios/:id/promocoes', ensureAdminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('promocoes').select('*').eq('sorteio_id', req.params.id).order('quantidade_cotas', { ascending: true });
    return ok(res, { lista: data || [] });
  } catch (e) { return fail(res); }
});
app.post('/api/admin/sorteios/:id/promocoes', ensureAdminAuth, async (req, res) => {
  try {
    const { titulo, quantidade_cotas, preco_promocional, ativo } = req.body || {};
    if (!quantidade_cotas || !preco_promocional) return fail(res, 'Preencha a quantidade e o preço promocional', 400);
    const { data, error } = await supabase.from('promocoes').insert({
      sorteio_id: req.params.id, titulo: titulo || 'Promoção',
      quantidade_cotas: parseInt(quantidade_cotas), preco_promocional: parseFloat(preco_promocional),
      ativo: ativo !== false
    }).select().single();
    if (error) return fail(res, error.message);
    return ok(res, { promocao: data });
  } catch (e) { return fail(res); }
});
app.put('/api/admin/promocoes/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { titulo, quantidade_cotas, preco_promocional, ativo } = req.body || {};
    const payload = {};
    if (titulo !== undefined) payload.titulo = titulo;
    if (quantidade_cotas !== undefined) payload.quantidade_cotas = parseInt(quantidade_cotas);
    if (preco_promocional !== undefined) payload.preco_promocional = parseFloat(preco_promocional);
    if (ativo !== undefined) payload.ativo = !!ativo;
    const { error } = await supabase.from('promocoes').update(payload).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/promocoes/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('promocoes').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

// Liga/desliga a roleta pra um sorteio sem precisar reenviar o formulário inteiro
app.post('/api/admin/sorteios/:id/roleta-ativada', ensureAdminAuth, async (req, res) => {
  try {
    const { roleta_ativada } = req.body || {};
    const { error } = await supabase.from('sorteios').update({ roleta_ativada: !!roleta_ativada }).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.post('/api/admin/sorteios/:id/roleta-giros-por-compra', ensureAdminAuth, async (req, res) => {
  try {
    const valor = Math.max(0, parseInt(req.body?.roleta_giros_por_compra) || 0);
    const { error } = await supabase.from('sorteios').update({ roleta_giros_por_compra: valor }).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});

app.post('/api/admin/sorteios/:id/roleta-tiers', ensureAdminAuth, async (req, res) => {
  try {
    const { minimo_cotas, quantidade_giros } = req.body || {};
    if (!minimo_cotas || !quantidade_giros) return fail(res, 'Preencha os dois campos', 400);
    const { data, error } = await supabase.from('roleta_tiers').insert({ sorteio_id: req.params.id, minimo_cotas, quantidade_giros }).select().single();
    if (error) return fail(res, error.message);
    return ok(res, data);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/roleta-tiers/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('roleta_tiers').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

// ==================================================================
// 📊 DASHBOARD API (métricas, buscas)
// ==================================================================

app.post('/api/admin/dashboard/buscar-ganhador', ensureAdminAuth, async (req, res) => {
  try {
    const { raffle, number } = req.body || {};
    if (!number) return fail(res, 'Número é obrigatório', 400);

    if (raffle) {
      const { data: bp } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', raffle).eq('numero_cota', number).maybeSingle();
      if (bp) {
        let usuario = null, pedido = null;
        if (bp.usuario_id) {
          const { data: u } = await supabase.from('usuarios').select('*').eq('id', bp.usuario_id).maybeSingle();
          usuario = u || null;
        }
        if (bp.pedido_id) {
          const { data: p } = await supabase.from('pedidos').select('*').eq('id', bp.pedido_id).maybeSingle();
          pedido = p || null;
        }
        return ok(res, { ...bp, cliente: usuario || { nome_completo: bp.nome_completo, telefone: bp.telefone }, pedido });
      }
    }
    const { data: cota } = await supabase.from('cotas').select('*').eq('numero_cota', number).maybeSingle();
    if (!cota) return fail(res, 'Cota não encontrada', 404);
    const result = { numero_cota: cota.numero_cota, sorteio_id: cota.sorteio_id };

    if (cota.pedido_id) {
      const { data: pedido } = await supabase.from('pedidos').select('*').eq('id', cota.pedido_id).maybeSingle();
      if (pedido) {
        result.pedido = pedido;
        if (pedido.user_id) {
          const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', pedido.user_id).maybeSingle();
          if (usuario) result.cliente = usuario;
        }
      }
    } else if (cota.user_id) {
      const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', cota.user_id).maybeSingle();
      if (usuario) result.cliente = usuario;
    }
    return ok(res, result);
  } catch (err) { return fail(res, 'Erro ao buscar ganhador'); }
});

app.get('/api/admin/dashboard/top-comprador', ensureAdminAuth, async (req, res) => {
  try {
    const { limit = 10, raffle, start_date, end_date, tipo } = req.query;
    let q = supabase.from('pedidos').select('*').eq('status', 'pago');
    if (raffle) q = q.eq('sorteio_id', raffle);
    if (start_date) q = q.gte('created_at', start_date);
    if (end_date) q = q.lte('created_at', end_date);
    const { data: pedidos } = await q;

    const map = new Map();
    (pedidos || []).forEach(p => {
      const uid = p.user_id;
      if (!uid) return;
      const cur = map.get(uid) || { user_id: uid, valor_total: 0 };
      cur.valor_total += Number(p.valor_total || 0);
      map.set(uid, cur);
    });

    const arr = Array.from(map.values());
    const userIds = arr.map(a => a.user_id);
    const { data: users } = userIds.length ? await supabase.from('usuarios').select('*').in('id', userIds) : { data: [] };
    const userMap = (users || []).reduce((acc, u) => (acc[u.id] = u, acc), {});
    const results = arr.map(r => ({ ...r, usuarios: userMap[r.user_id] || null })).sort((a, b) => tipo === 'menor' ? a.valor_total - b.valor_total : b.valor_total - a.valor_total);
    return ok(res, { results: results.slice(0, Number(limit)) });
  } catch (err) { return fail(res, 'Erro top comprador'); }
});

// Ranking por QUANTIDADE de cotas compradas (não por valor em R$) — "Maior/Menor Cota"
app.get('/api/admin/dashboard/maior-menor-cota', ensureAdminAuth, async (req, res) => {
  try {
    const { limit = 3, raffle, start_date, end_date, tipo } = req.query;
    let q = supabase.from('cotas').select('numero_cota, user_id, created_at');
    if (raffle) q = q.eq('sorteio_id', raffle);
    if (start_date) q = q.gte('created_at', start_date);
    if (end_date) q = q.lte('created_at', end_date);
    const { data: cotas } = await q;

    // Pra cada cliente, acha a cota MAIS ALTA (ou MAIS BAIXA) que ele adquiriu no período — não é
    // sobre quantidade comprada, é sobre o número real da cota (ex: comprou a 0000011, essa é a "dele").
    const porUsuario = new Map();
    (cotas || []).forEach(c => {
      if (!c.user_id) return;
      const num = Number(c.numero_cota);
      const atual = porUsuario.get(c.user_id);
      if (!atual || (tipo === 'menor' ? num < atual.extremo : num > atual.extremo)) {
        porUsuario.set(c.user_id, { user_id: c.user_id, extremo: num, numero_cota: c.numero_cota });
      }
    });

    const arr = Array.from(porUsuario.values()).sort((a, b) => tipo === 'menor' ? a.extremo - b.extremo : b.extremo - a.extremo);
    const top = arr.slice(0, Number(limit));
    const userIds = top.map(a => a.user_id);
    const { data: users } = userIds.length ? await supabase.from('usuarios').select('*').in('id', userIds) : { data: [] };
    const userMap = (users || []).reduce((acc, u) => (acc[u.id] = u, acc), {});
    const results = top.map(r => ({ numero_cota: r.numero_cota, usuarios: userMap[r.user_id] || null }));
    return ok(res, { results });
  } catch (err) { return fail(res, 'Erro maior/menor cota'); }
});

// Avisos de bilhetes/roleta premiados que saíram recentemente (pra sininho de notificação no dashboard)
app.get('/api/admin/notificacoes/recentes', ensureAdminAuth, async (req, res) => {
  try {
    const desde = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // últimas 48h
    const { data } = await supabase.from('bilhetes_premiados').select('*, sorteios(nome)').eq('status', 'reivindicada').gte('reivindicada_em', desde).order('reivindicada_em', { ascending: false }).limit(20);
    const bilhetes = data || [];
    const usuarioIds = [...new Set(bilhetes.map(b => b.usuario_id).filter(Boolean))];
    const { data: usuarios } = usuarioIds.length ? await supabase.from('usuarios').select('*').in('id', usuarioIds) : { data: [] };
    const usuarioMap = (usuarios || []).reduce((a, u) => (a[u.id] = u, a), {});
    const notificacoes = bilhetes.map(b => ({
      id: b.id, tipo: b.tipo, premio_titulo: b.premio_titulo,
      numero_cota: b.tipo === 'bilhete' ? b.numero_cota : null, // roleta nunca expõe a cota, nem aqui
      sorteio_nome: b.sorteios?.nome, reivindicada_em: b.reivindicada_em,
      ganhador: usuarioMap[b.usuario_id] || null
    }));
    return ok(res, { notificacoes });
  } catch (err) { console.error('GET notificacoes/recentes', err); return fail(res); }
});

app.get('/api/admin/dashboard/cards', ensureAdminAuth, async (req, res) => {
  try {
    const { sorteio_id, start_date, end_date } = req.query;
    const baseFilter = (q) => {
      if (sorteio_id && sorteio_id !== 'todos') q = q.eq('sorteio_id', sorteio_id);
      if (start_date) q = q.gte('updated_at', start_date);
      if (end_date) q = q.lte('updated_at', end_date);
      return q;
    };
    let qf = supabase.from('pedidos').select('valor_total, user_id').eq('status', 'pago');
    qf = baseFilter(qf);
    const { data: paid } = await qf;

    const nowISOCards = new Date().toISOString();
    let vp = supabase.from('pedidos').select('valor_total').eq('status', 'aguardando').gte('expira_em', nowISOCards);
    vp = baseFilter(vp);
    const { data: pend } = await vp;

    let qt = supabase.from('pedidos').select('id').neq('status', 'cancelado');
    qt = baseFilter(qt);
    const { data: all } = await qt;

    const faturamento = (paid || []).reduce((s, p) => s + Number(p.valor_total || 0), 0);
    const pendente = (pend || []).reduce((s, p) => s + Number(p.valor_total || 0), 0);
    const total_pedidos = (all || []).length;
    const total_clientes = new Set((paid || []).map(p => p.user_id).filter(Boolean)).size;
    const ticket_medio = total_pedidos > 0 ? (faturamento / total_pedidos) : 0;

    let qa = supabase.from('acessos_log').select('*', { head: true, count: 'exact' });
    if (sorteio_id && sorteio_id !== 'todos') qa = qa.eq('sorteio_id', sorteio_id);
    if (start_date) qa = qa.gte('created_at', start_date);
    if (end_date) qa = qa.lte('created_at', end_date);
    const { count: acessos } = await qa;

    return ok(res, { faturamento, pendente, total_pedidos, total_clientes, ticket_medio, acessos: acessos || 0 });
  } catch (err) { return fail(res); }
});

// Desempenho detalhado por sorteio (para a tabela "scroll pra baixo" do dashboard)
app.get('/api/admin/dashboard/por-sorteio', ensureAdminAuth, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const { data: sorteios } = await supabase.from('sorteios').select('id, nome').order('created_at', { ascending: false });
    const resultados = [];
    for (const s of (sorteios || [])) {
      let qp = supabase.from('pedidos').select('valor_total, status, expira_em').eq('sorteio_id', s.id);
      if (start_date) qp = qp.gte('created_at', start_date);
      if (end_date) qp = qp.lte('created_at', end_date);
      const { data: pedidos } = await qp;
      const nowISORel = new Date().toISOString();
      const pagos = (pedidos || []).filter(p => p.status === 'pago');
      const pendentes = (pedidos || []).filter(p => p.status === 'aguardando' && (!p.expira_em || p.expira_em >= nowISORel));
      const faturamento = pagos.reduce((s2, p) => s2 + Number(p.valor_total || 0), 0);
      const pendente = pendentes.reduce((s2, p) => s2 + Number(p.valor_total || 0), 0);
      const ticket_medio = pagos.length > 0 ? faturamento / pagos.length : 0;

      let qa = supabase.from('acessos_log').select('*', { head: true, count: 'exact' }).eq('sorteio_id', s.id);
      if (start_date) qa = qa.gte('created_at', start_date);
      if (end_date) qa = qa.lte('created_at', end_date);
      const { count: acessos } = await qa;

      const conversao = (acessos || 0) > 0 ? (pagos.length / acessos) * 100 : 0;
      resultados.push({ sorteio_id: s.id, nome: s.nome, acessos: acessos || 0, total_pedidos: (pedidos || []).length, faturamento, pendente, ticket_medio, conversao });
    }
    resultados.sort((a, b) => b.faturamento - a.faturamento);
    return ok(res, { sorteios: resultados });
  } catch (err) { console.error('GET por-sorteio', err); return fail(res); }
});

app.get('/api/admin/dashboard/vendas-diarias', ensureAdminAuth, async (req, res) => {
  try {
    const { start_date, end_date, sorteio_id } = req.query;
    const from = start_date ? new Date(start_date) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = end_date ? new Date(end_date) : new Date();
    let q = supabase.from('pedidos').select('updated_at, valor_total').eq('status', 'pago').gte('updated_at', from.toISOString()).lte('updated_at', to.toISOString());
    if (sorteio_id && sorteio_id !== 'todos') q = q.eq('sorteio_id', sorteio_id);
    const { data: paid } = await q;
    const map = {};
    (paid || []).forEach(p => {
      const k = (p.updated_at || '').slice(0, 10);
      if (!map[k]) map[k] = 0;
      map[k] += Number(p.valor_total || 0);
    });
    const labels = Object.keys(map).sort();
    const data = labels.map(l => Number(map[l] || 0));
    return ok(res, { labels, data });
  } catch (err) { return fail(res); }
});

app.get('/api/admin/sorteios/:id/premios', ensureAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await sincronizarBilhetesComCotasVendidas(id);
    const { data } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', id).eq('tipo', 'bilhete').order('created_at', { ascending: true });
    const bilhetes = data || [];
    const usuarioIds = [...new Set(bilhetes.map(b => b.usuario_id).filter(Boolean))];
    const pedidoIds = [...new Set(bilhetes.map(b => b.pedido_id).filter(Boolean))];
    const { data: usuarios } = usuarioIds.length ? await supabase.from('usuarios').select('*').in('id', usuarioIds) : { data: [] };
    const { data: pedidos } = pedidoIds.length ? await supabase.from('pedidos').select('id, valor_total, quantidade_cotas, token').in('id', pedidoIds) : { data: [] };
    const usuarioMap = (usuarios || []).reduce((a, u) => (a[u.id] = u, a), {});
    const pedidoMap = (pedidos || []).reduce((a, p) => (a[p.id] = p, a), {});
    const enriquecidos = bilhetes.map(b => ({ ...b, usuario: usuarioMap[b.usuario_id] || null, pedido: pedidoMap[b.pedido_id] || null }));
    return ok(res, { bilhetes_premiados: enriquecidos });
  } catch (err) { return fail(res); }
});

app.get('/api/admin/configuracoes', ensureAdminAuth, async (_req, res) => {
  try { const cfg = await fetchConfigFromDB(); return res.json(cfg); } catch { return fail(res); }
});

app.post('/api/admin/configuracoes', ensureAdminAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const ops = [];
    Object.entries(body).forEach(([k, v]) => {
      ops.push(supabase.from('configuracoes').upsert({ chave: k, valor: v }, { onConflict: 'chave' }));
    });
    await Promise.all(ops);
    await loadConfigToEnv();
    return ok(res, { msg: 'Configurações salvas!' });
  } catch (e) { return fail(res); }
});

app.post('/api/admin/upload-logo', ensureAdminAuth, upload.single('logo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return fail(res, 'Arquivo não enviado', 400);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    const dest = `logos/${Date.now()}-${safeName}`;
    const { error } = await supabase.storage.from('logos').upload(dest, file.buffer, { contentType: file.mimetype, upsert: true });
    if (error) return fail(res, error.message);
    const { data: pub } = supabase.storage.from('logos').getPublicUrl(dest);
    const publicURL = pub?.publicUrl;

    await supabase.from('configuracoes').upsert({ chave: 'LOGO_URL', valor: publicURL }, { onConflict: 'chave' });
    return ok(res, { url: publicURL });
  } catch (e) { return fail(res); }
});

app.post('/api/admin/conta', ensureAdminAuth, async (req, res) => {
  try {
    const { email, new_password, confirm_password } = req.body || {};
    const id = req.session.admin.id;
    const updates = {};
    if (email) updates.email = email;
    if (new_password) {
      if (new_password !== confirm_password) return fail(res, 'Senhas não conferem', 400);
      updates.password_hash = await bcrypt.hash(new_password, 10);
    }
    if (Object.keys(updates).length === 0) return ok(res, {});
    const { error } = await supabase.from('admin_users').update(updates).eq('id', id);
    if (error) return fail(res, error.message);
    if (email) req.session.admin.email = email;
    return ok(res, {});
  } catch { return fail(res); }
});

app.get('/api/admin/sorteios/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from('sorteios').select('*').eq('id', id).maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'Sorteio não encontrado' });
    return res.json(data);
  } catch { return fail(res); }
});

app.get('/api/admin/sorteios', ensureAdminAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase.from('sorteios').select('*').order('created_at', { ascending: false });
    if (error) return fail(res, 'Erro ao listar sorteios');
    const results = [];
    for (const s of (data || [])) {
      const { count } = await supabase.from('cotas').select('*', { head: true, count: 'exact' }).eq('sorteio_id', s.id);
      results.push({ ...s, cotas_vendidas: count || 0 });
    }
    return res.json(results);
  } catch { return fail(res); }
});

app.post('/api/admin/sorteios', ensureAdminAuth, upload.any(), async (req, res) => {
  try {
    const body = req.body || {};
    const files = req.files || [];
    const isEditing = body.sorteio_id && String(body.sorteio_id).trim() !== '' && body.sorteio_id !== 'undefined';

    let foto_url = body.foto_url || null;
    let fotos_galeria = body.fotos_galeria ? (Array.isArray(body.fotos_galeria) ? body.fotos_galeria : (() => {
      try { return JSON.parse(body.fotos_galeria || '[]'); } catch { return String(body.fotos_galeria || '').split(',').map(x => x.trim()).filter(Boolean); }
    })()) : [];

    // Com o input aceitando múltiplos arquivos, todos chegam com o mesmo fieldname ("foto_principal").
    // Se já existe uma foto principal mantida (kept via campo oculto), os novos uploads só entram na
    // galeria — nunca substituem a principal sem o usuário pedir isso explicitamente.
    let primeiraFotoDefinida = !!foto_url;
    for (const file of files) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
      const dest = `${isEditing ? body.sorteio_id : 'new'}/${Date.now()}-${safeName}`;
      const { error } = await supabase.storage.from('sorteios').upload(dest, file.buffer, { contentType: file.mimetype, upsert: true });
      if (!error) {
        const { data: pub } = supabase.storage.from('sorteios').getPublicUrl(dest);
        const publicURL = pub?.publicUrl;
        if (!primeiraFotoDefinida) {
          foto_url = publicURL;
          primeiraFotoDefinida = true;
        } else {
          fotos_galeria.push(publicURL);
        }
      }
    }

    const payload = {
      nome: body.nome,
      descricao: body.descricao,
      regulamento: body.regulamento || null,
      // notice_* removidos daqui — agora é a tabela avisos_urgencia, gerenciada pela aba própria
      preco_cota: parseFloat(body.preco_cota) || 0,
      total_cotas: parseInt(normalizeNumber(body.total_cotas)),
      tempo_pagamento: parseInt(normalizeNumber(body.tempo_pagamento)),
      minimo_cotas_compra: parseInt(normalizeNumber(body.minimo_cotas_compra)),
      maximo_cotas_compra: parseInt(normalizeNumber(body.maximo_cotas_compra)),
      minimo_visivel_seletor: parseInt(normalizeNumber(body.minimo_visivel_seletor)),
      botoes_rapidos: body.botoes_rapidos || null,
      foto_url: foto_url,
      fotos_galeria: fotos_galeria,
      status: body.status || 'rascunho',
      link_grupo_vip: body.link_grupo_vip || null,
      suporte_whatsapp: body.suporte_whatsapp || null,
      ganhador_nome: body.ganhador_nome || null,
      ganhador_cota: body.ganhador_cota || null,
      is_featured: body.is_featured === true || body.is_featured === 'true' || body.is_featured === 'on',
      pixel_fb_override: body.pixel_fb_override || null,
      pixel_google_override: body.pixel_google_override || null,
      pixel_tiktok_override: body.pixel_tiktok_override || null,
      pixel_gtm_override: body.pixel_gtm_override || null,
      coletar_cpf: body.coletar_cpf === true || body.coletar_cpf === 'true' || body.coletar_cpf === 'on',
      coletar_email: body.coletar_email === true || body.coletar_email === 'true' || body.coletar_email === 'on',
      coletar_endereco: body.coletar_endereco === true || body.coletar_endereco === 'true' || body.coletar_endereco === 'on',
      // roleta_ativada NÃO fica aqui — é gerenciado só pelo endpoint próprio /roleta-ativada (senão sobrescreve toda vez que salva o sorteio)
      roleta_pool_total: body.roleta_pool_total ? parseInt(body.roleta_pool_total) : 0,
      updated_at: new Date().toISOString()
    };

    if (!isEditing) {
      if (!payload.slug) {
        payload.slug = body.nome.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
      }
      const { data: existsSlug } = await supabase.from('sorteios').select('id').eq('slug', payload.slug).limit(1);
      if (existsSlug && existsSlug.length > 0) {
        payload.slug = payload.slug + '-' + Date.now();
      }

      const { data: inserted, error } = await supabase.from('sorteios').insert(payload).select().single();
      if (error) { console.error('Insert Error:', error); return res.status(500).json({ error: 'Erro DB: ' + error.message }); }
      return res.json({ status: 'success', sorteio: inserted });
    } else {
      const { data: updated, error } = await supabase.from('sorteios').update(payload).eq('id', body.sorteio_id).select().single();
      if (error) { console.error('Update Error:', error); return res.status(500).json({ error: 'Erro DB: ' + error.message }); }
      return res.json({ status: 'success', sorteio: updated });
    }
  } catch (err) { console.error('POST /api/admin/sorteios', err); return fail(res, err.message); }
});

app.get('/api/admin/pedidos/export-expirados', ensureAdminAuth, async (_req, res) => {
  try {
    const nowISO = new Date().toISOString();
    const { data } = await supabase.from('pedidos')
      .select('quantidade_cotas, valor_total, created_at, expira_em, usuarios(nome_completo, telefone, cpf), sorteios(nome)')
      .eq('status', 'aguardando').lt('expira_em', nowISO).order('created_at', { ascending: false });

    const linhas = (data || []).map(p => ({
      nome: p.usuarios?.nome_completo || '', telefone: p.usuarios?.telefone || '', cpf: p.usuarios?.cpf || '',
      sorteio: p.sorteios?.nome || '', quantidade_cotas: p.quantidade_cotas, valor_total: p.valor_total,
      criado_em: p.created_at, expirou_em: p.expira_em
    }));
    const csv = csvStringify(linhas, { header: true, columns: ['nome', 'telefone', 'cpf', 'sorteio', 'quantidade_cotas', 'valor_total', 'criado_em', 'expirou_em'] });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pedidos-expirados.csv"');
    return res.send(csv);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/pedidos/expirados', ensureAdminAuth, async (_req, res) => {
  try {
    const nowISO = new Date().toISOString();
    const { data: expirados } = await supabase.from('pedidos').select('id').eq('status', 'aguardando').lt('expira_em', nowISO);
    const ids = (expirados || []).map(p => p.id);
    if (ids.length === 0) return ok(res, { removidos: 0 });
    const { error } = await supabase.from('pedidos').delete().in('id', ids);
    if (error) return fail(res, error.message);
    return ok(res, { removidos: ids.length });
  } catch (e) { return fail(res); }
});

app.get('/api/admin/pedidos', ensureAdminAuth, async (req, res) => {
  try {
    const { filter, start_date, end_date } = req.query;
    const nowISO = new Date().toISOString();
    let q = supabase.from('pedidos').select('*, usuarios(nome_completo, telefone, cpf), sorteios(nome, slug), cotas(numero_cota), funis(nome, slug)');
    if (filter === 'pagos') q = q.eq('status', 'pago');
    else if (filter === 'pendentes') q = q.eq('status', 'aguardando').gte('expira_em', nowISO);
    else if (filter === 'expirados') q = q.eq('status', 'aguardando').lt('expira_em', nowISO);
    if (start_date) q = q.gte('created_at', start_date);
    if (end_date) q = q.lte('created_at', end_date);
    const { data } = await q.order('created_at', { ascending: false });
    return res.json(data || []);
  } catch { return fail(res); }
});

app.post('/api/admin/pedidos/:id/aprovar', ensureAdminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: p } = await supabase.from('pedidos').select('*').eq('id', id).maybeSingle();
    if (!p) return fail(res, 'Não encontrado', 404);

    const cotas = await gerarCotasUnicas(p);

    if (!cotas || cotas.length === 0) {
      return fail(res, 'Falha ao gerar cotas (Sorteio esgotado ou erro interno)', 400);
    }

    const { data: updatedPedido } = await supabase.from('pedidos').select('*').eq('id', id).maybeSingle();
    return ok(res, { pedido: updatedPedido || p, cotas });
  } catch (err) {
    console.error('Erro aprovar pedido:', err);
    return fail(res, 'Erro ao aprovar pedido');
  }
});

app.delete('/api/admin/pedidos/:id', ensureAdminAuth, async (req, res) => {
  const { error } = await supabase.from('pedidos').delete().eq('id', req.params.id);
  return error ? fail(res, error.message) : ok(res);
});

app.get('/api/admin/relatorios', ensureAdminAuth, async (req, res) => {
  try {
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const to = req.query.to ? new Date(`${req.query.to}T23:59:59`) : new Date();
    const { data: paid } = await supabase.from('pedidos').select('updated_at, valor_total, user_id').eq('status', 'pago').gte('updated_at', from.toISOString()).lte('updated_at', to.toISOString());
    const map = {};
    (paid || []).forEach(p => {
      const k = (p.updated_at || '').slice(0, 10);
      if (!map[k]) map[k] = { dia: k, pedidos: 0, faturamento: 0 };
      map[k].pedidos += 1; map[k].faturamento += Number(p.valor_total || 0);
    });
    const series = Object.values(map).sort((a, b) => a.dia.localeCompare(b.dia));
    const total_pedidos = series.reduce((acc, r) => acc + r.pedidos, 0);
    const total_faturado = series.reduce((acc, r) => acc + r.faturamento, 0);
    const total_clientes = new Set((paid || []).map(p => p.user_id).filter(Boolean)).size;

    const { data: despesas } = await supabase.from('despesas').select('*').gte('data', from.toISOString()).lte('data', to.toISOString());
    const total_despesas = (despesas || []).reduce((s, d) => s + Number(d.valor || 0), 0);
    const lucro_liquido = total_faturado - total_despesas;
    const roi = total_despesas > 0 ? (lucro_liquido / total_despesas) * 100 : null;

    // Junta despesas por dia na mesma série, pra alimentar o gráfico com faturamento/líquido/despesa lado a lado
    (despesas || []).forEach(d => {
      const k = (d.data || '').slice(0, 10);
      if (!map[k]) map[k] = { dia: k, pedidos: 0, faturamento: 0 };
      map[k].despesas = (map[k].despesas || 0) + Number(d.valor || 0);
    });
    const seriesCompleta = Object.values(map).sort((a, b) => a.dia.localeCompare(b.dia)).map(r => ({
      dia: r.dia, pedidos: r.pedidos, faturamento: r.faturamento,
      despesas: r.despesas || 0, liquido: r.faturamento - (r.despesas || 0)
    }));

    res.json({ from: String(req.query.from || ''), to: String(req.query.to || ''), series: seriesCompleta, total_pedidos, total_faturado, total_clientes, total_despesas, lucro_liquido, roi });
  } catch (err) { res.status(500).json({ error: 'Erro ao gerar relatório' }); }
});

// --- Despesas (pra calcular lucro líquido e ROI) ---
app.get('/api/admin/despesas', ensureAdminAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = supabase.from('despesas').select('*').order('data', { ascending: false });
    if (from) q = q.gte('data', `${from}T00:00:00`);
    if (to) q = q.lte('data', `${to}T23:59:59`);
    const { data } = await q;
    return ok(res, { despesas: data || [] });
  } catch (e) { return fail(res); }
});
app.post('/api/admin/despesas', ensureAdminAuth, async (req, res) => {
  try {
    const { nome, valor, data } = req.body || {};
    if (!nome || !valor) return fail(res, 'Nome e valor são obrigatórios', 400);
    const { data: inserted, error } = await supabase.from('despesas').insert({ nome, valor, data: data || new Date().toISOString() }).select();
    if (error) return fail(res, error.message);
    return ok(res, inserted);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/despesas/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('despesas').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

app.get('/api/admin/clientes', ensureAdminAuth, async (_req, res) => {
  const { data: u } = await supabase.from('usuarios').select('*').order('created_at', { ascending: false }).limit(1000);
  const { data: p } = await supabase.from('pedidos').select('user_id, valor_total, status, created_at, sorteio_id').eq('status', 'pago');

  // Descobre o sorteio "mais recente" (o último criado) pra saber se o cliente comprou nele (ativo no último sorteio)
  const { data: ultimoSorteio } = await supabase.from('sorteios').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle();

  const gasto = {}, ultimaCompra = {}, ativoUltimoSorteio = {};
  (p || []).forEach(x => {
    gasto[x.user_id] = (gasto[x.user_id] || 0) + Number(x.valor_total || 0);
    if (!ultimaCompra[x.user_id] || x.created_at > ultimaCompra[x.user_id]) ultimaCompra[x.user_id] = x.created_at;
    if (ultimoSorteio && x.sorteio_id === ultimoSorteio.id) ativoUltimoSorteio[x.user_id] = true;
  });

  const c = (u || []).map(user => ({
    ...user,
    total_gasto: Number((gasto[user.id] || 0).toFixed(2)),
    ultima_compra: ultimaCompra[user.id] || null,
    ativo_ultimo_sorteio: !!ativoUltimoSorteio[user.id]
  }));
  return res.json(c);
});
app.delete('/api/admin/clientes/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('usuarios').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});
app.get('/api/admin/clientes/:id/pedidos', ensureAdminAuth, async (req, res) => {
  const { data } = await supabase.from('pedidos').select('*, sorteios(nome)').eq('user_id', req.params.id).order('created_at', { ascending: false });
  return res.json(data || []);
});
app.get('/api/admin/clientes/:id/cotas', ensureAdminAuth, async (req, res) => {
  const { data } = await supabase.from('cotas').select('numero_cota, sorteio_id, sorteios(nome)').eq('user_id', req.params.id).order('created_at', { ascending: false });
  return res.json(data || []);
});
app.get('/api/admin/clientes/export', ensureAdminAuth, async (_req, res) => {
  try {
    const { data: u } = await supabase.from('usuarios').select('*').order('created_at', { ascending: false });
    const { data: p } = await supabase.from('pedidos').select('user_id, valor_total, status');
    const g = {};
    (p || []).filter(x => x.status === 'pago').forEach(x => g[x.user_id] = (g[x.user_id] || 0) + Number(x.valor_total || 0));
    const rows = (u || []).map(user => ({
      nome: user.nome_completo, telefone: user.telefone, email: user.email || '',
      total_gasto: Number((g[user.id] || 0).toFixed(2)), cadastrado_em: user.created_at
    }));
    const csv = csvStringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
    res.send(csv);
  } catch (err) { return fail(res); }
});

app.get('/api/admin/sorteios/:id/export', ensureAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const filtro = req.query.filtro || 'cotas';

    if (filtro === 'expirados') {
      const nowISO = new Date().toISOString();
      const { data: pedidos } = await supabase.from('pedidos').select('*, usuarios(nome_completo, telefone)').eq('sorteio_id', id).eq('status', 'aguardando').lt('expira_em', nowISO);
      const rows = (pedidos || []).map(p => ({ nome: p.usuarios?.nome_completo, telefone: p.usuarios?.telefone, quantidade_cotas: p.quantidade_cotas, valor: p.valor_total, expirou_em: p.expira_em }));
      const csv = csvStringify(rows, { header: true });
      res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="pedidos-expirados.csv"'); return res.send(csv);
    }

    if (filtro === 'compradores') {
      const { data: pedidos } = await supabase.from('pedidos').select('*, usuarios(nome_completo, telefone, email, cpf)').eq('sorteio_id', id).eq('status', 'pago');
      // Um comprador pode ter feito mais de um pedido — agrupa por usuário
      const porUsuario = new Map();
      (pedidos || []).forEach(p => {
        const uid = p.user_id;
        if (!uid) return;
        const cur = porUsuario.get(uid) || { nome: p.usuarios?.nome_completo, telefone: p.usuarios?.telefone, email: p.usuarios?.email, cpf: p.usuarios?.cpf, total_cotas: 0, total_gasto: 0 };
        cur.total_cotas += Number(p.quantidade_cotas || 0);
        cur.total_gasto += Number(p.valor_total || 0);
        porUsuario.set(uid, cur);
      });
      const rows = Array.from(porUsuario.values());
      const csv = csvStringify(rows, { header: true });
      res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="compradores.csv"'); return res.send(csv);
    }

    // filtro padrão: 'cotas' — lista de cotas geradas (comportamento original)
    const { data: c } = await supabase.from('cotas').select('numero_cota, pedido_id').eq('sorteio_id', id);
    const pIds = [...new Set((c || []).map(x => x.pedido_id))];
    const { data: p } = await supabase.from('pedidos').select('id, valor_total, created_at, user_id').in('id', pIds);
    const uIds = [...new Set((p || []).map(x => x.user_id))];
    const { data: u } = await supabase.from('usuarios').select('id, nome_completo, telefone').in('id', uIds);
    const uM = (u || []).reduce((a, x) => (a[x.id] = x, a), {});
    const pM = (p || []).reduce((a, x) => (a[x.id] = x, a), {});
    const rows = (c || []).map(x => { const ped = pM[x.pedido_id]; const usr = ped ? uM[ped.user_id] : null; return { nome: usr?.nome_completo, telefone: usr?.telefone, valor: ped?.valor_total, cota: x.numero_cota, data: ped?.created_at }; });
    const csv = csvStringify(rows, { header: true });
    res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename="cotas.csv"'); res.send(csv);
  } catch (err) { return fail(res); }
});

app.post('/api/admin/sorteios/:id/bloqueios', ensureAdminAuth, async (req, res) => {
  try {
    const { id } = req.params; const { numero_cota } = req.body;
    const { data: sorteioRef } = await supabase.from('sorteios').select('total_cotas').eq('id', id).maybeSingle();
    const numeroFormatado = padCota(String(numero_cota).replace(/\D/g, ''), sorteioRef?.total_cotas);
    const { data, error } = await supabase.from('cotas_bloqueadas').insert({ sorteio_id: id, numero_cota: numeroFormatado }).select().single();
    if (error) return fail(res, error.message); return ok(res, data);
  } catch (e) { return fail(res); }
});
app.get('/api/admin/sorteios/:id/bloqueios', ensureAdminAuth, async (req, res) => {
  try { const { id } = req.params; const { data } = await supabase.from('cotas_bloqueadas').select('*').eq('sorteio_id', id).order('created_at', { ascending: false }); return ok(res, { lista: data || [] }); } catch (e) { return fail(res); }
});
app.delete('/api/admin/bloqueios/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('cotas_bloqueadas').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

// Cotas agendadas: ficam bloqueadas até uma data/hora específica, depois liberam sozinhas
app.get('/api/admin/sorteios/:id/agendamentos', ensureAdminAuth, async (req, res) => {
  try { const { data } = await supabase.from('cotas_agendadas').select('*').eq('sorteio_id', req.params.id).order('liberar_em', { ascending: true }); return ok(res, { lista: data || [] }); } catch (e) { return fail(res); }
});
app.post('/api/admin/sorteios/:id/agendamentos', ensureAdminAuth, async (req, res) => {
  try {
    const { numero_cota, liberar_em, condicao_tipo, condicao_quantidade } = req.body || {};
    if (!numero_cota || !liberar_em) return fail(res, 'Cota e data são obrigatórios', 400);
    const { data: sorteioRef } = await supabase.from('sorteios').select('total_cotas').eq('id', req.params.id).maybeSingle();
    const numeroFormatado = padCota(String(numero_cota).replace(/\D/g, ''), sorteioRef?.total_cotas);
    const payload = { sorteio_id: req.params.id, numero_cota: numeroFormatado, liberar_em: new Date(liberar_em).toISOString() };
    if (condicao_tipo === 'acima' || condicao_tipo === 'abaixo') {
      payload.condicao_tipo = condicao_tipo;
      payload.condicao_quantidade = parseInt(condicao_quantidade) || null;
    }
    const { data, error } = await supabase.from('cotas_agendadas').insert(payload).select().single();
    if (error) return fail(res, error.message);
    return ok(res, data);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/agendamentos/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('cotas_agendadas').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});

app.post('/api/admin/sorteios/:id/premios', ensureAdminAuth, async (req, res) => {
  try {
    const { id } = req.params; const { numero_cota, premio_titulo, ativo } = req.body;
    const { data: sorteioRef } = await supabase.from('sorteios').select('total_cotas').eq('id', id).maybeSingle();
    const numeroFormatado = padCota(String(numero_cota).replace(/\D/g, ''), sorteioRef?.total_cotas);

    // Verifica se essa cota já foi vendida antes de cadastrar o bilhete — se já foi, marca reivindicado na hora
    const { data: cotaVendida } = await supabase.from('cotas').select('user_id, pedido_id').eq('sorteio_id', id).eq('numero_cota', numeroFormatado).maybeSingle();
    const payload = { sorteio_id: id, numero_cota: numeroFormatado, premio_titulo, tipo: 'bilhete', ativo: ativo !== false };
    if (cotaVendida) {
      payload.status = 'reivindicada';
      payload.usuario_id = cotaVendida.user_id || null;
      payload.pedido_id = cotaVendida.pedido_id || null;
      payload.reivindicada_em = new Date().toISOString();
    } else {
      payload.status = 'disponivel';
    }

    const { data, error } = await supabase.from('bilhetes_premiados').insert(payload).select().single();
    if (error) return fail(res, error.message); return ok(res, data);
  } catch (e) { return fail(res); }
});
app.put('/api/admin/premios/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { premio_titulo, ativo, numero_cota, sorteio_id } = req.body || {};
    const payload = {};
    if (premio_titulo !== undefined) payload.premio_titulo = premio_titulo;
    if (ativo !== undefined) payload.ativo = !!ativo;
    if (numero_cota !== undefined) {
      const { data: sorteioRef } = await supabase.from('sorteios').select('total_cotas').eq('id', sorteio_id).maybeSingle();
      payload.numero_cota = padCota(String(numero_cota).replace(/\D/g, ''), sorteioRef?.total_cotas);
    }
    const { error } = await supabase.from('bilhetes_premiados').update(payload).eq('id', req.params.id);
    if (error) return fail(res, error.message); return ok(res);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/premios/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('bilhetes_premiados').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
});
// Marca manualmente um bilhete/roleta como já reivindicado (pra registrar ganhadores que saíram fora do fluxo normal de compra)
app.post('/api/admin/premios/:id/marcar-reivindicado', ensureAdminAuth, async (req, res) => {
  try {
    const { nome_completo, telefone } = req.body || {};
    if (!nome_completo) return fail(res, 'Nome do ganhador é obrigatório', 400);
    const telefoneLimpo = String(telefone || '').replace(/\D/g, '') || null;

    let usuario_id = null;
    if (telefoneLimpo) {
      const { data: existente } = await supabase.from('usuarios').select('id').eq('telefone', telefoneLimpo).maybeSingle();
      if (existente) usuario_id = existente.id;
      else {
        const { data: novo } = await supabase.from('usuarios').insert({ nome_completo, telefone: telefoneLimpo }).select('id').single();
        usuario_id = novo?.id || null;
      }
    }

    const { error } = await supabase.from('bilhetes_premiados').update({
      status: 'reivindicada', usuario_id, reivindicada_em: new Date().toISOString(),
      nome_completo: usuario_id ? null : nome_completo // fallback se não tiver telefone pra vincular usuário
    }).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.post('/api/admin/premios/:id/desmarcar-reivindicado', ensureAdminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('bilhetes_premiados').update({ status: 'disponivel', usuario_id: null, pedido_id: null, reivindicada_em: null }).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/sorteios/:id', ensureAdminAuth, async (req, res) => {
  try {
    await supabase.from('cotas').delete().eq('sorteio_id', req.params.id);
    await supabase.from('cotas_bloqueadas').delete().eq('sorteio_id', req.params.id);
    await supabase.from('bilhetes_premiados').delete().eq('sorteio_id', req.params.id);
    await supabase.from('funis').delete().eq('sorteio_id', req.params.id);
    const { error } = await supabase.from('sorteios').delete().eq('id', req.params.id);
    if (error) return fail(res, error.message); return ok(res);
  } catch (e) { return fail(res); }
});

// ==================================================================
// 💳 GATEWAY DE PAGAMENTO (config + criação de pagamento genérica)
// ==================================================================

async function getConfigValue(key) {
  try {
    const { data } = await supabase.from('configuracoes').select('valor').eq('chave', key).limit(1).maybeSingle();
    return data?.valor || null;
  } catch (e) {
    console.error('getConfigValue error', e);
    return null;
  }
}

app.post('/api/admin/gateway-config', ensureAdminAuth, async (req, res) => {
  try {
    const { chave, valor } = req.body;
    if (!chave) return res.status(400).json({ error: 'chave obrigatoria' });
    await supabase.from('configuracoes').upsert({ chave, valor }, { onConflict: 'chave' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('gateway-config save error', e);
    return res.status(500).json({ error: 'erro' });
  }
});

app.get('/api/gateway/current', async (req, res) => {
  try {
    const provider = await getConfigValue('gateway_provider') || 'mercadopago';
    const mp_token = await getConfigValue('mp_access_token');
    const pay2m_id = await getConfigValue('pay2m_client_id');
    const paggue_token = await getConfigValue('paggue_access_token');
    return res.json({ provider, has_mp: !!mp_token, has_pay2m: !!pay2m_id, has_paggue: !!paggue_token });
  } catch (e) {
    return res.status(500).json({ error: 'erro' });
  }
});

app.post('/api/gateway/create-payment', async (req, res) => {
  try {
    const { pedido_id, nome_completo, telefone } = req.body;
    if (!pedido_id) return res.status(400).json({ error: 'pedido_id obrigatorio' });

    const { data: pedido } = await supabase.from('pedidos').select('*').eq('id', pedido_id).maybeSingle();
    if (!pedido) return res.status(404).json({ error: 'pedido nao encontrado' });

    const provider = (await getConfigValue('gateway_provider')) || 'mercadopago';

    if (provider === 'mercadopago') {
      const mpToken = await getConfigValue('mp_access_token') || process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!mpToken) return res.status(400).json({ error: 'mp token nao configurado' });

      const amount = Number(pedido.valor_total || 0);
      const body = {
        transaction_amount: amount,
        payment_method_id: 'pix',
        description: `Pedido #${pedido.id} - ${pedido.sorteio_id}`,
        payer: { email: (nome_completo || '').replace(/\s/g, '') + '@example.com', first_name: nome_completo || 'Cliente' }
      };

      const resp = await fetch('https://api.mercadopago.com/v1/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${mpToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(400).json({ error: data.message || 'erro no gateway' });

      const trx = data.point_of_interaction?.transaction_data || {};
      const qr_code_base64 = trx.qr_code_base64 || null;
      const qr_payload = trx.qr_code || trx.qrcode || null;
      const ticket_url = trx.ticket_url || null;
      const payment_id = data.id || null;

      await supabase.from('pedidos').update({
        pix_copia_cola: qr_payload,
        pix_qr_code_base64: qr_code_base64,
        payment_link: ticket_url,
        gateway_payment_id: String(payment_id),
        gateway_provider: 'mercadopago',
        gateway_data: data
      }).eq('id', pedido.id);

      return res.json({ payment: { payment_link: ticket_url, pix_copia_cola: qr_payload, pix_qr_code_base64: qr_code_base64, gateway_payment_id: payment_id } });
    } else if (provider === 'pay2m') {
      const client_id = await getConfigValue('pay2m_client_id');
      const client_secret = await getConfigValue('pay2m_client_secret');
      if (!client_id || !client_secret) return res.status(400).json({ error: 'pay2m nao configurado' });

      const amount = Number(pedido.valor_total || 0);
      const resp = await fetch('https://api.pay2m.com.br/v1/pix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-id': client_id, 'x-client-secret': client_secret },
        body: JSON.stringify({ amount, description: `Pedido ${pedido.id}` })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(400).json({ error: data.message || 'erro no gateway' });

      const qr_code_base64 = data.pix?.qr_code_base64 || null;
      const qr_payload = data.pix?.payload || data.pix?.qrcode || null;
      const ticket_url = data.pix?.url || null;
      const payment_id = data.id || null;

      await supabase.from('pedidos').update({
        pix_copia_cola: qr_payload,
        pix_qr_code_base64: qr_code_base64,
        payment_link: ticket_url,
        gateway_payment_id: String(payment_id),
        gateway_provider: 'pay2m',
        gateway_data: data
      }).eq('id', pedido.id);

      return res.json({ payment: { payment_link: ticket_url, pix_copia_cola: qr_payload, pix_qr_code_base64: qr_code_base64, gateway_payment_id: payment_id } });
    } else if (provider === 'paggue') {
      const paggueToken = await getConfigValue('paggue_access_token');
      if (!paggueToken) return res.status(400).json({ error: 'paggue nao configurado' });

      const amount = Number(pedido.valor_total || 0);
      // ⚠️ Endpoint ilustrativo — confirme o path exato na documentação da Paggue e ajuste aqui.
      const resp = await fetch('https://api.paggue.io/v1/pix/charges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${paggueToken}` },
        body: JSON.stringify({ amount, description: `Pedido ${pedido.id}` })
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(400).json({ error: data.message || 'erro no gateway paggue' });

      const qr_code_base64 = data.qr_code_base64 || data.pix?.qr_code_base64 || null;
      const qr_payload = data.qr_code || data.pix?.payload || null;
      const ticket_url = data.payment_link || null;
      const payment_id = data.id || null;

      await supabase.from('pedidos').update({
        pix_copia_cola: qr_payload,
        pix_qr_code_base64: qr_code_base64,
        payment_link: ticket_url,
        gateway_payment_id: String(payment_id),
        gateway_provider: 'paggue',
        gateway_data: data
      }).eq('id', pedido.id);

      return res.json({ payment: { payment_link: ticket_url, pix_copia_cola: qr_payload, pix_qr_code_base64: qr_code_base64, gateway_payment_id: payment_id } });
    } else {
      return res.status(400).json({ error: 'gateway desconhecido' });
    }
  } catch (e) {
    console.error('create-payment error', e.response?.data || e.message || e);
    return res.status(500).json({ error: 'erro ao criar pagamento' });
  }
});

app.post('/api/webhook/pagamento', async (req, res) => {
  try {
    let payload = req.body;
    if (Buffer.isBuffer(payload)) {
      try { payload = JSON.parse(payload.toString('utf8')); } catch { payload = {}; }
    }
    const paymentId = payload.id || payload.data?.id || payload['collection_id'] || null;
    if (!paymentId) return res.status(400).json({ error: 'no id found' });

    const { data: pedido } = await supabase.from('pedidos').select('*').eq('gateway_payment_id', String(paymentId)).maybeSingle();

    if (!pedido) {
      console.warn('Pedido not found for paymentId', paymentId);
      return res.json({ ok: true });
    }

    await supabase.from('pedidos').update({ status: 'pago', updated_at: new Date().toISOString() }).eq('id', pedido.id);

    if (!pedido.cotas_array || pedido.cotas_array.length === 0) {
      await gerarCotasUnicas(pedido);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('webhook processing error', e);
    return res.status(500).json({ error: 'erro' });
  }
});

// ==================================================================
// 🔔 NOTIFICAÇÕES PUSH
// ==================================================================

// Chave pública — o site precisa dela pra pedir permissão de notificação
app.get('/api/public/push/vapid-public-key', (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push não configurado' });
  return res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Salva (ou reativa) a inscrição de um navegador
app.post('/api/public/push/subscribe', async (req, res) => {
  try {
    const { subscription, telefone, sorteio_id } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return fail(res, 'Inscrição inválida', 400);
    }
    const telefoneLimpo = telefone ? String(telefone).replace(/\D/g, '') : null;
    let user_id = null;
    if (telefoneLimpo) {
      const { data: u } = await supabase.from('usuarios').select('id').eq('telefone', telefoneLimpo).maybeSingle();
      user_id = u?.id || null;
    }
    const { data: existente } = await supabase.from('push_inscricoes').select('id').eq('endpoint', subscription.endpoint).maybeSingle();
    if (existente) {
      await supabase.from('push_inscricoes').update({ ativo: true, desativado_em: null, user_id, sorteio_id: sorteio_id || null }).eq('id', existente.id);
    } else {
      await supabase.from('push_inscricoes').insert({
        endpoint: subscription.endpoint, chave_p256dh: subscription.keys.p256dh, chave_auth: subscription.keys.auth,
        telefone: telefoneLimpo, user_id, sorteio_id: sorteio_id || null, ativo: true
      });
    }
    return ok(res);
  } catch (e) { console.error('push/subscribe', e); return fail(res); }
});
app.post('/api/public/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return fail(res, 'Endpoint é obrigatório', 400);
    await supabase.from('push_inscricoes').update({ ativo: false, desativado_em: new Date().toISOString() }).eq('endpoint', endpoint);
    return ok(res);
  } catch (e) { return fail(res); }
});
// Confirma clique numa notificação (chamado pelo service worker)
app.post('/api/public/push/registrar-clique/:disparoId', async (req, res) => {
  try {
    const { data: d } = await supabase.from('push_disparos').select('total_clicado').eq('id', req.params.disparoId).maybeSingle();
    if (d) await supabase.from('push_disparos').update({ total_clicado: (d.total_clicado || 0) + 1 }).eq('id', req.params.disparoId);
    return ok(res);
  } catch (e) { return fail(res); }
});

// ---- ADMIN ----
app.get('/api/admin/push/config', ensureAdminAuth, async (_req, res) => {
  const cfg = await fetchConfigFromDB();
  return ok(res, { ativo: cfg.PUSH_ATIVO === 'true', configurado: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) });
});
app.post('/api/admin/push/config', ensureAdminAuth, async (req, res) => {
  try {
    const { ativo } = req.body || {};
    await supabase.from('configuracoes').upsert({ chave: 'PUSH_ATIVO', valor: String(!!ativo) }, { onConflict: 'chave' });
    return ok(res);
  } catch (e) { return fail(res); }
});
app.get('/api/admin/push/stats', ensureAdminAuth, async (_req, res) => {
  try {
    const { count: totalAtivos } = await supabase.from('push_inscricoes').select('*', { head: true, count: 'exact' }).eq('ativo', true);
    const { count: totalDesativados } = await supabase.from('push_inscricoes').select('*', { head: true, count: 'exact' }).eq('ativo', false);
    const { count: totalGeral } = await supabase.from('push_inscricoes').select('*', { head: true, count: 'exact' });
    return ok(res, { ativos: totalAtivos || 0, desativados: totalDesativados || 0, total: totalGeral || 0 });
  } catch (e) { return fail(res); }
});
app.get('/api/admin/push/disparos', ensureAdminAuth, async (_req, res) => {
  try {
    const { data } = await supabase.from('push_disparos').select('*, sorteios(nome)').order('created_at', { ascending: false }).limit(50);
    return ok(res, { lista: data || [] });
  } catch (e) { return fail(res); }
});
app.post('/api/admin/push/disparar', ensureAdminAuth, async (req, res) => {
  try {
    if (!configurarPush()) return fail(res, 'Chaves VAPID não configuradas no servidor (rode scripts/gerar-chaves-push.js e configure as variáveis de ambiente)', 500);

    const { titulo, mensagem, imagem_url, link_destino, sorteio_id } = req.body || {};
    if (!titulo) return fail(res, 'Título é obrigatório', 400);

    const { data: disparo, error: errDisparo } = await supabase.from('push_disparos').insert({
      titulo, mensagem: mensagem || '', imagem_url: imagem_url || null, link_destino: link_destino || '/', sorteio_id: sorteio_id || null
    }).select().single();
    if (errDisparo) return fail(res, errDisparo.message);

    const { data: inscricoes } = await supabase.from('push_inscricoes').select('*').eq('ativo', true);
    let enviados = 0;
    await Promise.all((inscricoes || []).map(async (insc) => {
      const payload = JSON.stringify({
        title: titulo, body: mensagem || '', icon: imagem_url || undefined, image: imagem_url || undefined,
        url: link_destino || '/', disparoId: disparo.id
      });
      try {
        await webPush.sendNotification({ endpoint: insc.endpoint, keys: { p256dh: insc.chave_p256dh, auth: insc.chave_auth } }, payload);
        enviados++;
      } catch (err) {
        // Inscrição morta (usuário desinstalou/bloqueou) — desativa pra não tentar de novo
        if (err.statusCode === 404 || err.statusCode === 410) {
          await supabase.from('push_inscricoes').update({ ativo: false, desativado_em: new Date().toISOString() }).eq('id', insc.id);
        }
      }
    }));

    await supabase.from('push_disparos').update({ total_enviado: enviados }).eq('id', disparo.id);
    return ok(res, { disparo_id: disparo.id, enviados, total_inscritos: (inscricoes || []).length });
  } catch (e) { console.error('push/disparar', e); return fail(res); }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

// ==================================================================
// 🗄️ BANCO DE DADOS
// ==================================================================
// O SQL completo (todas as tabelas e colunas que este arquivo usa) está em
// database.sql, na raiz do projeto. Rode aquele arquivo inteiro no SQL Editor
// do Supabase antes de subir o servidor.
