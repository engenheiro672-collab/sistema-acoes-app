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
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import multer from 'multer';
import sharp from 'sharp';
import { stringify as csvStringify } from 'csv-stringify/sync';
import webPush from 'web-push';
import rateLimit from 'express-rate-limit';
import zlib from 'zlib';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// ⚡ Comprime toda resposta de texto (HTML, CSS, JS, JSON) antes de mandar pro navegador — sem
// isso, cada página ia inteira, "crua". Testei em 9 cenários diferentes antes de aplicar aqui
// (JSON, HTML, arquivo do disco, imagem — pra garantir que nunca comprime binário por engano,
// múltiplos pedaços escritos separadamente, e sem pedir gzip). Com o funil-01.html de verdade,
// a redução foi de 75% (74KB -> 18KB).
app.use((req, res, next) => {
  const aceitaGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (!aceitaGzip) return next();

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let gzip = null;
  let comprimindo = null; // null = ainda não decidido; true/false = já decidido pro tipo dessa resposta
  const pedacosAntesDeDecidir = [];

  function tipoTextoComprimivel() {
    const ct = String(res.getHeader('Content-Type') || '');
    return /text\/|application\/json|application\/javascript|image\/svg/.test(ct);
  }

  function iniciarGzipSeNecessario() {
    if (comprimindo !== null) return;
    comprimindo = tipoTextoComprimivel() && !res.getHeader('Content-Encoding');
    if (!comprimindo) return;
    res.setHeader('Content-Encoding', 'gzip');
    res.removeHeader('Content-Length'); // o tamanho muda depois de comprimir
    res.setHeader('Vary', 'Accept-Encoding');
    gzip = zlib.createGzip();
    gzip.on('data', chunk => originalWrite(chunk));
    gzip.on('end', () => originalEnd());
  }

  res.write = function (chunk, ...args) {
    if (comprimindo === null) { pedacosAntesDeDecidir.push(chunk); return true; }
    if (comprimindo) return gzip.write(chunk);
    return originalWrite(chunk, ...args);
  };

  res.end = function (chunk, ...args) {
    if (chunk) pedacosAntesDeDecidir.push(chunk);
    iniciarGzipSeNecessario();
    if (comprimindo) {
      pedacosAntesDeDecidir.forEach(c => gzip.write(c));
      gzip.end();
    } else {
      if (pedacosAntesDeDecidir.length === 0) return originalEnd(...args);
      if (pedacosAntesDeDecidir.length === 1) return originalEnd(pedacosAntesDeDecidir[0], ...args);
      pedacosAntesDeDecidir.slice(0, -1).forEach(c => originalWrite(c));
      return originalEnd(pedacosAntesDeDecidir[pedacosAntesDeDecidir.length - 1], ...args);
    }
  };

  // Garante que já sabemos o Content-Type antes de decidir comprimir.
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function (...args) {
    iniciarGzipSeNecessario();
    return originalWriteHead(...args);
  };

  next();
});

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

// Confere se um CPF é matematicamente válido (dígitos verificadores batem) antes de mandar pro
// Mercado Pago — sem isso, um CPF digitado errado (ou de teste) faz a API deles recusar o pedido
// inteiro com "Invalid user identification number", e o comprador nunca recebe o PIX de verdade.
function cpfEhValido(cpf) {
  const c = String(cpf || '').replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(c[i], 10) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10) resto = 0;
  if (resto !== parseInt(c[9], 10)) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(c[i], 10) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10) resto = 0;
  if (resto !== parseInt(c[10], 10)) return false;
  return true;
}

// ==================================================================
// ⚙️ SETUP SERVIDOR
// ==================================================================

// 🔒 Antes, qualquer site da internet podia fazer pedido pro seu sistema levando os cookies de quem
// estivesse logado (e ainda ler a resposta) — "origin: true" aceitava literalmente qualquer origem.
// Agora só os domínios que você realmente usa têm permissão.
// 🔒 O painel roda num subdomínio separado (panthers.premiosderrets.com.br). Qualquer link que o
// SERVIDOR gera pro cliente (não só o painel) tem que apontar pro domínio de verdade do site,
// nunca pro endereço de onde a requisição chegou (que, vindo do painel, seria o subdomínio errado).
const DOMINIO_PUBLICO_SERVIDOR = 'https://premiosderrets.com.br';

const ORIGENS_PERMITIDAS = [
  'https://premiosderrets.com.br',
  'https://www.premiosderrets.com.br',
  'https://panthers.premiosderrets.com.br',
  'https://sistema-acoes-app.onrender.com'
];
app.use(cors({
  origin: (origin, callback) => {
    // Sem "origin" = pedido do próprio servidor (webhook, curl, etc.) — sempre permite.
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) return callback(null, true);
    return callback(new Error('Origem não permitida'));
  },
  credentials: true
}));

// 🔒 Cabeçalhos de segurança que faltavam — protegem contra um tipo de golpe chamado "clickjacking"
// (alguém colocar seu site escondido dentro de um iframe em outro site, tentando enganar o clique
// da pessoa) e reforçam outras proteções básicas que o navegador já sabe fazer, se avisado.
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cookieParser());
// Necessário no Render (e qualquer host atrás de proxy/HTTPS) pra sessão/cookies funcionarem certo
// ⚡ Sempre ativa (não depende mais de NODE_ENV estar configurado certinho no Render) — no Render
// você está SEMPRE atrás do proxy deles, então isso precisa estar ligado sempre, em qualquer
// ambiente. Sem isso, o rate-limit (limite de tentativas) pode tratar todo mundo que acessa o site
// como se fosse a mesma pessoa/IP, o que pode bloquear visitantes de verdade sem motivo.
app.set('trust proxy', 1);

// 🔒 Em produção, exige que SESSION_SECRET esteja configurado de verdade — nunca usa um valor
// padrão conhecido, porque isso permitiria forjar sessões de admin se alguém descobrisse essa chave.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('🚨 ERRO CRÍTICO: SESSION_SECRET não está configurado nas variáveis de ambiente. O servidor não vai iniciar até isso ser corrigido, por segurança.');
  process.exit(1);
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'chave-apenas-para-desenvolvimento-local-nunca-use-em-producao',
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

// 🔒 Trava o subdomínio do painel (panthers.premiosderrets.com.br) pra só responder o que é
// realmente do painel — nada de site público, nada de arquivo estático solto. Se alguém acessar
// qualquer outro caminho por esse endereço (ex: /inicio, /sorteio/algo), recebe 404, como se
// aquele caminho nem existisse ali. O painel não depende de nenhum arquivo local pra funcionar
// (CSS/JS vêm de CDN externo, a logo vem do Supabase), então dá pra travar sem quebrar nada.
app.use((req, res, next) => {
  const ehSubdominioDoPainel = (req.hostname || '').toLowerCase() === 'panthers.premiosderrets.com.br';
  if (!ehSubdominioDoPainel) return next();

  const caminhosPermitidos = ['/', '/login', '/logout'];
  const ehPermitido = caminhosPermitidos.includes(req.path) || req.path.startsWith('/api/admin');
  if (!ehPermitido) return res.status(404).send('Not found');
  return next();
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
// 🔒 Antes aceitava qualquer tipo de arquivo (mesmo sendo o upload só pra fotos) — agora só imagens de verdade.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (tiposPermitidos.includes(file.mimetype)) return cb(null, true);
    return cb(new Error('Só é permitido enviar imagens (JPEG, PNG, WEBP ou GIF).'));
  }
});

// ⚡ Comprime e redimensiona toda foto enviada, ANTES de guardar — isso é o que mais pesa na
// velocidade do site pro cliente. Uma foto de celular chega com uns 3-8MB; depois disso, fica
// girando em torno de 100-250KB, sem perda visível de qualidade numa tela de celular.
async function comprimirImagem(buffer, mimetype, larguraMaxima = 1280) {
  try {
    if (mimetype === 'image/gif') return { buffer, mimetype, extensao: 'gif' }; // GIF (pode ser animado) fica como está
    // WebP: mesmo visual que JPEG/PNG, mas 25-50% menor — ganho real principalmente em conexões
    // ou motores mais lentos (como navegadores de dentro de apps tipo Instagram). Suporta
    // transparência também, então funciona bem tanto pra fotos quanto pra logos com fundo transparente.
    const comprimida = await sharp(buffer).resize({ width: larguraMaxima, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    return { buffer: comprimida, mimetype: 'image/webp', extensao: 'webp' };
  } catch (e) {
    console.error('Erro ao comprimir imagem, usando original', e);
    return { buffer, mimetype, extensao: null };
  }
}

function ok(res, payload = {}) { return res.json({ status: 'success', ...payload }); }
function fail(res, message = 'Erro interno', code = 500) { return res.status(code).json({ status: 'error', error: message }); }

// ⚡ A tabela "configuracoes" (logo, pixels, redes sociais) quase nunca muda, mas antes era buscada
// do banco em TODA página, de TODO visitante. Agora guarda em memória por 60s — o painel força uma
// atualização na hora quando você salva algo (função invalidarCacheConfig abaixo), então nunca fica
// desatualizado por muito tempo, mas a visita comum do dia a dia nem toca o banco pra isso.
let _configCache = null;
let _configCacheEm = 0;
const CONFIG_CACHE_MS = 60 * 1000;
function invalidarCacheConfig() { _configCache = null; }

async function fetchConfigFromDB() {
  if (_configCache && (Date.now() - _configCacheEm) < CONFIG_CACHE_MS) return _configCache;
  try {
    const { data, error } = await supabase.from('configuracoes').select('*');
    if (error) return _configCache || {};
    const obj = {};
    (data || []).forEach(r => {
      const k = r.chave || r.key;
      const v = r.valor || r.value;
      if (k) obj[k] = v;
    });
    _configCache = obj;
    _configCacheEm = Date.now();
    return obj;
  } catch { return _configCache || {}; }
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

// ⚡ Mesmo esquema de cache já usado pra "configuracoes" — os pixels extras quase nunca mudam,
// então guardar por 60s evita bater no banco em toda visita de todo mundo.
let _pixelsExtrasCache = null;
let _pixelsExtrasCacheEm = 0;
function invalidarCachePixelsExtras() { _pixelsExtrasCache = null; }
async function fetchPixelsExtrasDoBanco() {
  if (_pixelsExtrasCache && (Date.now() - _pixelsExtrasCacheEm) < CONFIG_CACHE_MS) return _pixelsExtrasCache;
  try {
    const { data } = await supabase.from('pixels_meta_extras').select('pixel_id').eq('ativo', true);
    const ids = (data || []).map(r => r.pixel_id).filter(Boolean);
    _pixelsExtrasCache = ids;
    _pixelsExtrasCacheEm = Date.now();
    return ids;
  } catch { return _pixelsExtrasCache || []; }
}

async function getPublicMeta() {
  const cfg = await fetchConfigFromDB();
  const pixelIdsExtras = await fetchPixelsExtrasDoBanco();
  return {
    logo_url: cfg.LOGO_URL || process.env.LOGO_URL || '',
    pixel_id: cfg.FACEBOOK_PIXEL_ID || process.env.FACEBOOK_PIXEL_ID || '',
    pixel_google: cfg.GOOGLE_ADS_ID || '',
    pixel_tiktok: cfg.TIKTOK_PIXEL_ID || '',
    pixel_gtm: cfg.GTM_ID || '',
    pixel_ids_extras: pixelIdsExtras,
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
  return res.redirect('https://panthers.premiosderrets.com.br/login');
}

// ==================================================================
// 📁 ARQUIVOS ESTÁTICOS (front-end 100% HTML/JS)
// ==================================================================
// 🔒 Bloqueia acesso direto ao dashboard.html pelo nome do arquivo — só passa por aqui quem entrar
// pelo caminho secreto do painel (que exige login). Sem isso, qualquer um que soubesse o nome do
// arquivo conseguia ver o código inteiro do painel, mesmo sem estar logado.
app.get('/dashboard.html', (req, res) => {
  const veioDoSubdominio = (req.hostname || '').toLowerCase() === 'panthers.premiosderrets.com.br';
  return res.redirect(veioDoSubdominio ? '/login' : 'https://panthers.premiosderrets.com.br/login');
});

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
// 🔐 LOGIN ADMIN — só existe pelo subdomínio (panthers.premiosderrets.com.br) agora.
// O link numérico antigo foi desativado por completo, a pedido.
// ==================================================================

// Trava contra força bruta: no máximo 8 tentativas de login por IP a cada 15 minutos.
const limiteLoginAdmin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', error: 'Muitas tentativas de login. Aguarde alguns minutos e tente de novo.' }
});

// 🔒 Trava genérica pra endpoints públicos sensíveis — evita alguém "varrer" telefones em massa
// tentando descobrir quem é cliente, ou martelar criação de pedidos sem parar.
const limitePublicoSensivel = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', error: 'Muitas tentativas seguidas. Aguarde um pouco e tente de novo.' }
});

// Lista os arquivos HTML customizados que existem em public/funis/ — assim o painel sempre mostra
// os arquivos de verdade que estão no servidor, sem precisar editar código toda vez que adiciona um novo.
app.get('/api/admin/funis/arquivos-disponiveis', ensureAdminAuth, (_req, res) => {
  try {
    const pastaFunis = path.join(PUBLIC_DIR, 'funis');
    if (!fs.existsSync(pastaFunis)) return ok(res, { arquivos: [] });
    const arquivos = fs.readdirSync(pastaFunis).filter(f => f.toLowerCase().endsWith('.html'));
    return ok(res, { arquivos });
  } catch (e) { return fail(res); }
});

app.get('/api/admin/session', (req, res) => {
  if (req.session?.admin?.email) return ok(res, { authenticated: true, admin: req.session.admin });
  return res.status(401).json({ status: 'error', authenticated: false });
});

// ==================================================================
// 🔐 ACESSO TAMBÉM VIA SUBDOMÍNIO (panthers.premiosderrets.com.br)
// Funciona em paralelo com o link secreto de cima — as duas portas continuam
// exigindo login de verdade, nenhuma das duas mostra nada sem senha certa.
// ==================================================================
const SUBDOMINIO_PAINEL = 'panthers.premiosderrets.com.br';
function ehSubdominioPainel(req) {
  return (req.hostname || '').toLowerCase() === SUBDOMINIO_PAINEL;
}

app.get('/', (req, res, next) => {
  if (!ehSubdominioPainel(req)) return next();
  if (req.session?.admin?.email) return sendPage(res, 'dashboard.html');
  return res.redirect('/login');
});

app.get('/login', (req, res, next) => {
  if (!ehSubdominioPainel(req)) return next();
  return sendPage(res, 'login.html');
});

app.post('/login', limiteLoginAdmin, async (req, res, next) => {
  if (!ehSubdominioPainel(req)) return next();
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 'Email e senha obrigatórios', 400);
    const { data: user } = await supabase.from('admin_users').select('*').eq('email', email).maybeSingle();
    const credenciaisInvalidas = () => fail(res, 'E-mail ou senha incorretos.', 401);
    if (!user) return credenciaisInvalidas();
    if (user.status === 'suspended') return fail(res, 'Conta suspensa', 403);
    const okPass = await bcrypt.compare(password, user.password_hash || '');
    if (!okPass) return credenciaisInvalidas();
    req.session.admin = { id: user.id, email: user.email, name: user.name || 'Admin' };
    return ok(res, { redirect: '/' });
  } catch (err) { console.error('admin login error (subdomínio)', err); return fail(res, 'Erro no login'); }
});

app.post('/logout', (req, res, next) => {
  if (!ehSubdominioPainel(req)) return next();
  return req.session.destroy(() => ok(res, { redirect: '/login' }));
});

// ==================================================================
// 🌐 PÁGINAS PÚBLICAS (servem HTML estático; dados vêm via /api/public/*)
// ==================================================================
// ⚡ Reaproveitada tanto pela página inicial pré-carregada quanto pela API — junta as 2 buscas que
// não dependem uma da outra pra rodarem ao mesmo tempo (antes, uma esperava a outra terminar).
async function getInicioPublicData() {
  const [{ data: sorteios }, { data: ganhadores }, meta] = await Promise.all([
    supabase.from('sorteios').select('*').eq('status', 'ativo').order('is_featured', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from('sorteios').select('id,nome,slug,ganhador_nome,ganhador_cota').eq('status', 'concluido').not('ganhador_nome', 'is', null).limit(5).order('updated_at', { ascending: false }),
    getPublicMeta()
  ]);
  const pixels = { facebook_pixel_id: meta.pixel_id, facebook_pixel_ids_extras: meta.pixel_ids_extras || [], google_ads_id: meta.pixel_google, tiktok_pixel_id: meta.pixel_tiktok, gtm_id: meta.pixel_gtm };
  return { sorteios: sorteios || [], ganhadores: ganhadores || [], ...meta, pixels };
}

app.get('/', (_req, res) => res.redirect('/inicio'));
app.get('/inicio', async (_req, res) => {
  // ⚡ Mesmo truque do sorteio.html e do checkout: manda a lista de sorteios já pronta DENTRO do
  // HTML, então a página inicial não precisa esperar uma busca à parte pra mostrar tudo.
  const html = lerHtmlComCache('index.html');
  let htmlFinal = html;
  try {
    const dados = await getInicioPublicData();
    const dadosSeguro = JSON.stringify(dados).replace(/</g, '\\u003c');
    htmlFinal = html.replace('</head>', `<script>window.__DADOS_INICIAIS_INICIO__ = ${dadosSeguro};</script></head>`);
  } catch (errDados) { console.error('Erro ao pré-carregar dados da página inicial', errDados); }
  res.set('Content-Type', 'text/html');
  res.set('Cache-Control', 'no-cache');
  return res.send(htmlFinal);
});
app.get('/termos-de-uso', (_req, res) => sendPage(res, 'termos-de-uso.html'));
app.get('/politica-de-privacidade', (_req, res) => sendPage(res, 'politica-de-privacidade.html'));
// Middleware de rastreamento: roda em qualquer acesso à página do sorteio.
// Detecta link manual (?lk=codigo) ou origem automática (utm/gclid/fbclid) e registra o clique.
// ⚡ Registra o clique/acesso SEM fazer a pessoa esperar: chama next() na hora (a página já começa
// a carregar), e só depois disso é que as consultas de rastreamento rodam, "por trás". Antes, essas
// até 5 idas ao banco (uma atrás da outra) aconteciam ANTES da página nem começar a ser buscada —
// agora elas não atrasam mais nada que a pessoa vê.
// ⚡ Antes, toda vez que a pessoa dava F5 na página do sorteio, isso contava como um acesso novo
// (tanto no seu painel quanto — indiretamente — nos números que você olha pra decidir se o
// anúncio está indo bem). Agora só conta a PRIMEIRA vez dentro de uma janela de 6 horas: marca
// isso com um cookiezinho no navegador da pessoa, e enquanto ele existir, um F5 (ou reabrir a
// mesma aba) não soma outro acesso. Depois de 6 horas (ou numa visita de outro dia), conta de
// novo normalmente — continua sendo uma visita nova de verdade.
function trackearAcesso(req, res, next) {
  // ⚡ Isso é uma busca "por trás dos panos" do Service Worker, só pra atualizar o cache — a pessoa
  // não clicou em nada novo. Deixa a página ser gerada normalmente (pro cache pegar a versão
  // fresca), mas não conta como acesso nem mexe em nenhum contador.
  if (req.query._swrevalidate) return next();
  const slugAtual = req.params.slug || 'geral';
  // ⚡ O selo de "já contei essa visita" precisa ser por ORIGEM, não só por sorteio — senão, quem
  // visita primeiro por um link rastreado (ex: Instagram) e depois testa o link oficial (sem
  // parâmetro) tem a segunda visita ignorada, porque o selo do sorteio já existia. Com o selo
  // separado por origem, cada fonte de tráfego tem sua própria janela de 6h, então trocar de link
  // (ou usar o oficial depois de outro) sempre conta certinho na primeira vez.
  const origemChave = req.query.lk ? String(req.query.lk) : 'oficial';
  const cookieKey = `acesso_${slugAtual}_${origemChave}`;
  const jaContabilizado = !!(req.cookies && req.cookies[cookieKey]);
  if (!jaContabilizado) {
    try { res.cookie(cookieKey, '1', { maxAge: 6 * 60 * 60 * 1000, httpOnly: false, sameSite: 'lax' }); } catch (e) {}
  }
  next();
  if (jaContabilizado) return;
  (async () => {
    try {
      const { data: sorteio } = await supabase.from('sorteios').select('id').eq('slug', req.params.slug).maybeSingle();
      if (sorteio) {
        let funil = null;
        // ⚡ req.funilResolvidoPorAtribuicao existe quando a pessoa já tinha um funil "gravado" de
        // uma visita anterior — antes isso só era conhecido depois de um redirecionamento; agora
        // resolverAtribuicaoLinkOficial já deixa essa informação pronta aqui, sem redirecionar.
        const funilSlugParaBuscar = req.params.funilSlug || req.funilResolvidoPorAtribuicao;
        if (funilSlugParaBuscar) {
          const { data: f } = await supabase.from('funis').select('id, nome, slug').eq('sorteio_id', sorteio.id).eq('slug', funilSlugParaBuscar).maybeSingle();
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
    } catch (err) { console.error('trackearAcesso error (fundo)', err); }
  })();
}

// Escapa texto pra colocar dentro de atributo HTML com segurança (evita quebrar a página com aspas/símbolos)
function escaparAtributoHtml(texto) {
  return String(texto || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Injeta os dados reais do sorteio (foto, título, descrição) no HTML antes de mandar — necessário porque
// o WhatsApp/Instagram/Facebook NÃO executam o JavaScript da página, só leem o HTML puro que o servidor manda.
// ⚡ Guarda o conteúdo desses arquivos HTML em memória depois da 1ª leitura — evita ler o disco de
// novo em toda visita (os arquivos só mudam quando você faz um novo deploy, então é seguro).
const _cacheHtmlArquivos = new Map();
function lerHtmlComCache(caminhoRelativo) {
  if (_cacheHtmlArquivos.has(caminhoRelativo)) return _cacheHtmlArquivos.get(caminhoRelativo);
  const conteudo = fs.readFileSync(path.join(PUBLIC_DIR, caminhoRelativo), 'utf-8');
  _cacheHtmlArquivos.set(caminhoRelativo, conteudo);
  return conteudo;
}

function enviarSorteioComOg(res, dadosCompletos, req, nomeArquivo = 'sorteio.html') {
  const html = lerHtmlComCache(nomeArquivo);
  const sorteio = dadosCompletos?.sorteio;
  // ⚡ Título da ABA do navegador: só o nome do sorteio, puro e simples. Já o título usado quando
  // o link é COMPARTILHADO (WhatsApp/Instagram/Facebook mostrando a prévia) continua mais completo
  // — são duas coisas diferentes, cada uma com seu próprio texto agora.
  const tituloAba = sorteio?.nome || 'Sorteio';
  const titulo = sorteio?.nome ? `${sorteio.nome} — Participe e concorra!` : 'Sorteio';
  const descricao = sorteio?.descricao ? String(sorteio.descricao).slice(0, 150) : 'Participe e concorra a prêmios incríveis!';
  const imagem = sorteio?.foto_url || '';
  const urlCompleta = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  let htmlComOg = html
    .replaceAll('__PAGE_TITLE__', escaparAtributoHtml(tituloAba))
    .replaceAll('__OG_TITLE__', escaparAtributoHtml(titulo))
    .replaceAll('__OG_DESCRIPTION__', escaparAtributoHtml(descricao))
    .replaceAll('__OG_IMAGE__', escaparAtributoHtml(imagem))
    .replaceAll('__OG_URL__', escaparAtributoHtml(urlCompleta));

  // ⚡ A parte que elimina a "ida e volta" pra buscar os dados: já manda os dados reais do sorteio
  // DENTRO do HTML — assim que a página chega no navegador, não precisa mais esperar uma busca à
  // parte pra mostrar a foto/preço/tudo. Só faz isso pro sorteio.html padrão (React) — funis
  // customizados continuam com a lógica própria deles, sem serem afetados por essa mudança.
  if (dadosCompletos) {
    const dadosSeguro = JSON.stringify(dadosCompletos).replace(/</g, '\\u003c'); // evita fechar a tag <script> por acidente
    htmlComOg = htmlComOg.replace('</head>', `<script>window.__DADOS_INICIAIS__ = ${dadosSeguro};</script></head>`);
  }

  res.set('Content-Type', 'text/html');
  res.set('Cache-Control', 'no-cache'); // nunca guarda em cache — sempre busca a versão certa (padrão ou funil) de novo
  return res.send(htmlComOg);
}

// ⭐⭐ SISTEMA DE ATRIBUIÇÃO DE LINK — a lógica inteira do "link gravado" mora aqui.
//
// Regra: qualquer link COM código de rastreio (?lk=) que a pessoa clicar de propósito vira o
// "link gravado" dela — WhatsApp, Instagram, um funil específico, não importa. A partir daí,
// qualquer navegação que devolveria ela pro sorteio (clicar em "início" de novo, roleta, combo,
// botão "voltar") sempre usa ESSE MESMO link gravado — nunca cria um link novo, nunca cai no
// link oficial. Só troca se a pessoa clicar de propósito noutro link com código diferente
// (último clique sempre vale). O link OFICIAL (sem ?lk=) nunca participa dessa "gravação" —
// ele já é o destino natural quando não tem nada gravado, não precisa de memória especial.
const NOME_COOKIE_ATRIBUICAO = (slug) => `atrib_${slug}`;

function lerAtribuicaoCravada(req, slug) {
  try {
    const bruto = req.cookies?.[NOME_COOKIE_ATRIBUICAO(slug)];
    return bruto ? JSON.parse(bruto) : null;
  } catch (e) { return null; }
}
function gravarAtribuicao(res, slug, lk, funilSlug) {
  res.cookie(NOME_COOKIE_ATRIBUICAO(slug), JSON.stringify({ lk: lk || null, funilSlug: funilSlug || null }), { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
}

// Roda ANTES de qualquer contagem de acesso, só na rota "pura" (sem funil na URL) — decide se
// essa visita precisa usar um link/funil já gravado antes, ou se grava um link novo.
//
// ⚡ Antes, quando já existia uma atribuição gravada, isso mandava um REDIRECIONAMENTO HTTP pro
// navegador (302) — ou seja, o navegador precisava fazer uma ida-e-volta inteira ao servidor só
// pra descobrir a URL final, e SÓ DEPOIS fazer a ida-e-volta de verdade que traz a página. Numa
// rede de celular (e principalmente dentro do navegador embutido do Instagram/Facebook), isso
// dobra o tempo de rede antes de qualquer coisa aparecer na tela — exatamente a "tela branca de
// alguns segundos antes de abrir" que foi relatada. Agora isso é resolvido por dentro, na MESMA
// resposta, sem nunca redirecionar: a URL que a pessoa vê continua igual, só o conteúdo entregue
// já é decidido direto.
function resolverAtribuicaoLinkOficial(req, res, next) {
  const slug = req.params.slug;
  if (req.query.lk) {
    // Link novo de verdade sendo clicado — sempre tem prioridade, grava ele por cima do que
    // já existia (último clique vale). Sem funil, já que é a rota "pura".
    gravarAtribuicao(res, slug, req.query.lk, null);
    return next();
  }
  // Não veio nenhum ?lk= novo — confere se já tem algum link gravado de antes.
  const cravado = lerAtribuicaoCravada(req, slug);
  if (cravado && (cravado.lk || cravado.funilSlug)) {
    if (cravado.lk) req.query.lk = cravado.lk;
    req.funilResolvidoPorAtribuicao = cravado.funilSlug || null;
  }
  next();
}

// Na rota do FUNIL, chegar aqui (com ou sem ?lk=) já é, em si, um destino deliberado — nunca
// desvia pra outro link gravado. Só grava esse funil como o link atual, e segue normal.
function gravarAtribuicaoDoFunil(req, res, next) {
  gravarAtribuicao(res, req.params.slug, req.query.lk || null, req.params.funilSlug);
  next();
}

// ⚡ Função compartilhada — resolve e entrega a página certa (padrão ou arquivo customizado de um
// funil) pro sorteio. Usada tanto na rota "pura" (/sorteio/:slug, quando tem atribuição gravada
// apontando pra um funil) quanto na rota explícita de funil (/sorteio/:slug/:funilSlug) — assim
// as duas nunca ficam com lógicas parecidas-mas-diferentes espalhadas pelo código.
// ⚡ TELA DE ESPERA DO PRIMEIRO ACESSO — experimento, só no sorteio.html (layout padrão) por
// enquanto. A ideia: em vez de fazer a pessoa esperar toda a busca no banco pra ver QUALQUER
// coisa na tela, mandamos a página em duas partes:
//   1) Escrita e enviada IMEDIATAMENTE, sem esperar nada do banco — só a tela de espera (a foto
//      do anúncio, com uma animaçãozinha e um "carregando").
//   2) Escrita só depois que os dados de verdade chegarem — o resto do site, mais um scriptzinho
//      que esconde a tela de espera suavemente, revelando o site pronto por baixo.
// Só acontece na PRIMEIRA visita da pessoa (marcado com um cookie) — da segunda em diante, vai
// direto pro carregamento normal, que já é rápido.
const TELA_ESPERA_HTML = `<div id="tela-espera-inicial" style="position:fixed;inset:0;z-index:99999;background:#20242e;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity .5s ease;">
  <img src="https://mundialrefrigeracao.online/moto..JPEG" alt="" style="width:220px;height:220px;object-fit:cover;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.5);animation:pulsarFotoEspera 1.6s ease-in-out infinite;">
  <div style="width:34px;height:34px;border:3px solid rgba(255,255,255,.25);border-top-color:#4ade80;border-radius:50%;margin-top:28px;animation:girarSpinnerEspera .8s linear infinite;"></div>
</div>
<style>
  @keyframes pulsarFotoEspera { 0%,100% { transform:scale(1); } 50% { transform:scale(1.05); } }
  @keyframes girarSpinnerEspera { to { transform:rotate(360deg); } }
  #tela-espera-inicial.escondendo { opacity:0; pointer-events:none; }
</style>`;

async function enviarSorteioComTelaDeEspera(req, res, slug) {
  const htmlBase = lerHtmlComCache('sorteio.html');
  const marcador = '<body class="pb-8">';
  const idx = htmlBase.indexOf(marcador);
  if (idx === -1) {
    // Segurança: se o arquivo mudou e o marcador não existe mais, cai pro caminho normal.
    const dados = await getSorteioPublicData(slug, null);
    if (!dados) return res.status(404).send('Sorteio não encontrado');
    return enviarSorteioComOg(res, dados, req);
  }

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');

  // ⚡ A parte 1 (cabeçalho + tela de espera) sai NA HORA, sem esperar nada — as tags de
  // compartilhamento (OG) ficam com um texto genérico aqui, porque a essa altura ainda não
  // sabemos os dados do sorteio (isso não afeta quem clica no link — só afetaria uma prévia
  // nova do WhatsApp/Instagram sendo gerada nesse exato instante, o que é raríssimo pra uma
  // campanha já ativa, já que a prévia é gerada uma vez só quando o link é criado).
  const urlCompleta = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const parte1 = htmlBase.slice(0, idx + marcador.length)
    .replaceAll('__PAGE_TITLE__', 'Sorteio')
    .replaceAll('__OG_TITLE__', 'Sorteio')
    .replaceAll('__OG_DESCRIPTION__', 'Participe e concorra a prêmios incríveis!')
    .replaceAll('__OG_IMAGE__', '')
    .replaceAll('__OG_URL__', escaparAtributoHtml(urlCompleta));
  res.write(parte1 + TELA_ESPERA_HTML);

  // ⚡ Só AGORA busca os dados de verdade — a pessoa já está vendo a tela de espera enquanto isso
  // acontece por trás, em vez de olhar pra uma tela branca.
  let dados;
  try { dados = await getSorteioPublicData(slug, null); } catch (e) { console.error('Erro ao buscar dados (tela de espera)', e); }
  if (!dados) {
    res.end('<p style="color:#fff;text-align:center;padding:2rem;">Sorteio não encontrado.</p></body></html>');
    return;
  }

  // ⚡ Avisa a página (sem precisar de mais nenhuma ida ao banco — é só um cálculo, não uma
  // consulta) qual foi a origem que o SERVIDOR já usou pra contar esse acesso. Assim, se a pessoa
  // comprar, a compra usa o MESMO código — nunca mais fica "clique contado aqui, compra atribuída
  // ali", que era o motivo do link oficial aparecer com acesso mas sem nenhuma compra vinculada.
  dados.codigo_rastreamento_resolvido = req.query.lk || detectarOrigemAutomatica(req.query, req.headers.referer, null).codigo;

  const resto = htmlBase.slice(idx + marcador.length);
  const dadosSeguro = JSON.stringify(dados).replace(/</g, '\\u003c');
  const scriptRevelar = `<script>(function(){var el=document.getElementById('tela-espera-inicial');if(el){el.classList.add('escondendo');setTimeout(function(){el.remove();},550);}})();</script>`;

  res.write(`<script>window.__DADOS_INICIAIS__ = ${dadosSeguro};</script>` + resto + scriptRevelar);
  res.end();
}

async function servirPaginaSorteio(req, res, slug, funilSlug) {
  // ⚡ Mesma correção da tela de espera: avisa a página qual código de rastreio o servidor já
  // usou pra contar esse acesso, pra compra usar exatamente o mesmo (nunca mais desalinhado).
  const codigoResolvido = req.query.lk || detectarOrigemAutomatica(req.query, req.headers.referer, funilSlug ? { slug: funilSlug, nome: funilSlug } : null).codigo;

  if (!funilSlug) {
    const dados = await getSorteioPublicData(slug, null);
    if (!dados) return res.status(404).send('Sorteio não encontrado');
    dados.codigo_rastreamento_resolvido = codigoResolvido;
    return enviarSorteioComOg(res, dados, req);
  }
  const { data: sorteio } = await supabase.from('sorteios').select('id').eq('slug', slug).maybeSingle();
  if (!sorteio) return res.status(404).send('Sorteio não encontrado');
  const { data: funil } = await supabase.from('funis').select('arquivo_html').eq('sorteio_id', sorteio.id).eq('slug', funilSlug).maybeSingle();
  if (!funil) console.warn(`[funil] Nenhum funil encontrado com slug "${funilSlug}" pro sorteio "${slug}" — servindo a página padrão.`);
  const arquivo = funil?.arquivo_html || 'sorteio.html';
  // Arquivos customizados ficam em public/funis/; 'sorteio.html' é o layout padrão em public/
  if (arquivo && arquivo !== 'sorteio.html') {
    const customPath = path.join(PUBLIC_DIR, 'funis', arquivo);
    if (fs.existsSync(customPath)) {
      const dados = await getSorteioPublicData(slug, funilSlug);
      dados.codigo_rastreamento_resolvido = codigoResolvido;
      return enviarSorteioComOg(res, dados, req, path.join('funis', arquivo));
    }
    console.warn(`[funil] Funil "${funilSlug}" aponta pro arquivo "${arquivo}", mas ele NÃO existe em public/funis/ — caindo pro padrão.`);
  }
  const dados = await getSorteioPublicData(slug, funilSlug);
  dados.codigo_rastreamento_resolvido = codigoResolvido;
  return enviarSorteioComOg(res, dados, req);
}

app.get('/sorteio/:slug', resolverAtribuicaoLinkOficial, trackearAcesso, async (req, res) => {
  try {
    const slug = req.params.slug;
    const funilSlug = req.funilResolvidoPorAtribuicao || null;

    // A tela de espera só faz sentido no layout padrão (sorteio.html) e só na PRIMEIRA visita —
    // marcado com um cookie de 30 dias. Da segunda visita em diante, vai direto pro carregamento
    // normal (que já é rápido), sem repetir a tela de espera à toa.
    if (!funilSlug) {
      const cookieVisita = `viu_espera_${slug}`;
      const jaViu = !!(req.cookies && req.cookies[cookieVisita]);
      if (!jaViu) {
        try { res.cookie(cookieVisita, '1', { maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }); } catch (e) {}
        return await enviarSorteioComTelaDeEspera(req, res, slug);
      }
    }

    return await servirPaginaSorteio(req, res, slug, funilSlug);
  } catch (err) {
    console.error('Erro ao montar preview do sorteio', err);
    return sendPage(res, 'sorteio.html');
  }
});

// Serve o HTML correto para o funil: cada funil pode apontar pra um arquivo diferente em public/funis/
app.get('/sorteio/:slug/:funilSlug', gravarAtribuicaoDoFunil, trackearAcesso, async (req, res) => {
  try {
    return await servirPaginaSorteio(req, res, req.params.slug, req.params.funilSlug);
  } catch (err) {
    console.error('Erro ao resolver arquivo do funil', err);
    return sendPage(res, 'sorteio.html');
  }
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
    let arquivoRelativo = 'checkout.html';
    if (pedido?.funil_id) {
      const { data: funil } = await supabase.from('funis').select('arquivo_checkout_html').eq('id', pedido.funil_id).maybeSingle();
      const arquivo = funil?.arquivo_checkout_html || 'checkout.html';
      if (arquivo && arquivo !== 'checkout.html') {
        const customPath = path.join(PUBLIC_DIR, 'funis', arquivo);
        if (fs.existsSync(customPath)) arquivoRelativo = path.join('funis', arquivo);
      }
    }

    // ⚡ Mesmo truque do sorteio.html: manda os dados do pedido já prontos DENTRO do HTML, então o
    // checkout não precisa esperar uma busca à parte pra mostrar tudo — corta uma ida-e-volta
    // inteira bem na página onde a pessoa está prestes a pagar.
    const html = lerHtmlComCache(arquivoRelativo);
    let htmlFinal = html;
    let imagemSorteio = '';
    try {
      const dados = await getCheckoutPublicData(req.params.token);
      if (dados) {
        imagemSorteio = dados.pedido?.sorteios?.foto_url || '';
        const dadosSeguro = JSON.stringify(dados).replace(/</g, '\\u003c');
        htmlFinal = html.replace('</head>', `<script>window.__DADOS_INICIAIS_CHECKOUT__ = ${dadosSeguro};</script></head>`);
      }
    } catch (errDados) { console.error('Erro ao pré-carregar dados do checkout', errDados); }
    // A foto do sorteio já vem preenchida no HTML — começa a baixar assim que a página chega no
    // navegador, sem esperar o jQuery carregar e processar os dados pra só então setar a imagem.
    htmlFinal = htmlFinal.replace('__CHECKOUT_IMG__', escaparAtributoHtml(imagemSorteio));

    res.set('Content-Type', 'text/html');
    res.set('Cache-Control', 'no-cache');
    return res.send(htmlFinal);
  } catch (err) { console.error('Erro ao resolver checkout do funil', err); }
  return sendPage(res, 'checkout.html');
});

// ==================================================================
// 📡 API PÚBLICA — DADOS PARA AS PÁGINAS HTML
// ==================================================================

app.get('/api/public/inicio', async (_req, res) => {
  try {
    const dados = await getInicioPublicData();
    return ok(res, dados);
  } catch (err) { console.error('GET /api/public/inicio', err); return fail(res); }
});

async function getSorteioPublicData(slug, funilSlug) {
  const { data: sorteio } = await supabase.from('sorteios').select('*').eq('slug', slug).maybeSingle();
  if (!sorteio) return null;

  // Tudo que NÃO depende do resultado de outra consulta roda de uma vez só, em paralelo —
  // antes disso, cada uma dessas ia uma atrás da outra, e cada "ida e volta" ao banco custa tempo.
  const nowISO2 = new Date().toISOString();
  // ⚡ Antes, isso contava (COUNT) todas as linhas da tabela "cotas" a cada visita — rápido em
  // sorteios pequenos, mas cada vez mais lento conforme o sorteio cresce (a causa real de "3
  // segundos" em sorteios grandes). Agora só lê o contador pronto (sorteio.cotas_vendidas),
  // atualizado a cada compra em gerarCotasUnicas — leitura instantânea, não importa o tamanho.
  const [
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
    supabase.from('cotas_bloqueadas').select('numero_cota').eq('sorteio_id', sorteio.id),
    supabase.from('cotas_agendadas').select('numero_cota, liberar_em').eq('sorteio_id', sorteio.id),
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
  const vendidas = Number(sorteio.cotas_vendidas || 0);

  // ⚡ Essa correção de segurança (bilhete marcado errado por alguma inconsistência rara) NÃO
  // precisa fazer a pessoa esperar — ela roda "por trás", sem atrasar a resposta. Se corrigir
  // algo, já vale pra próxima visita; a visita atual usa os dados como já estavam (praticamente
  // sempre já corretos mesmo, essa é só uma rede de segurança extra).
  sincronizarBilhetesComCotasVendidas(sorteio.id, bilhetesTudo || []).catch(err => console.error('sincronizarBilhetesComCotasVendidas (fundo)', err));
  const bilhetesCorrigidos = bilhetesTudo || [];

  const nowISO = nowISO2;
  const bloq = new Set((bloqueadas || []).map(b => b.numero_cota));
  const agnd = new Set((agendadas || []).filter(a => a.liberar_em && a.liberar_em > nowISO).map(a => a.numero_cota));
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

  // O Bilhete Premiado é pra aparecer mesmo, número e tudo — é a graça da funcionalidade, o cliente
  // precisa saber qual cota procurar depois de comprar. A proteção de verdade é garantir que a cota
  // só é sorteada/atribuída DEPOIS do pagamento confirmado (não antes, num pedido ainda pendente).
  const bilhetesComNome = bilhetes.map(b => ({
    numero_cota: b.numero_cota,
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
    facebook_pixel_ids_extras: meta.pixel_ids_extras || [],
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

  const sorteioDoPedido = pedido.sorteios || {};

  // ⚡ Nenhuma dessas 4 consultas depende do resultado das outras — só do "pedido" que já veio
  // ali de cima. Antes rodavam uma atrás da outra (4 idas e voltas ao banco); agora rodam todas
  // ao mesmo tempo (1 ida e volta).
  const [{ data: funilData }, meta, cfg, { data: roletaTiersData }] = await Promise.all([
    pedido.funil_id ? supabase.from('funis').select('*').eq('id', pedido.funil_id).maybeSingle() : Promise.resolve({ data: null }),
    getPublicMeta(),
    fetchConfigFromDB(),
    sorteioDoPedido.roleta_ativada
      ? supabase.from('roleta_tiers').select('*').eq('sorteio_id', sorteioDoPedido.id).order('minimo_cotas', { ascending: true })
      : Promise.resolve({ data: [] })
  ]);
  const funil = funilData || null;
  const pixels = {
    facebook_pixel_id: sorteioDoPedido.pixel_fb_override || meta.pixel_id || '',
    facebook_pixel_ids_extras: meta.pixel_ids_extras || [],
    google_ads_id: sorteioDoPedido.pixel_google_override || meta.pixel_google || '',
    tiktok_pixel_id: sorteioDoPedido.pixel_tiktok_override || meta.pixel_tiktok || '',
    gtm_id: sorteioDoPedido.pixel_gtm_override || meta.pixel_gtm || ''
  };
  const modo_teste_pagamento = cfg.MODO_TESTE_PAGAMENTO === 'true' || cfg.MODO_TESTE_PAGAMENTO === 'on';
  const roleta_tiers = roletaTiersData || [];

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
    const { data: pedido } = await supabase.from('pedidos').select('id, sorteio_id').eq('token', req.params.token).maybeSingle();
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado' });
    const { data: giros } = await supabase.from('roleta_giros').select('*').eq('pedido_id', pedido.id).order('created_at', { ascending: true });
    const publico = (giros || []).map(g => ({
      id: g.id, girado: g.girado,
      premio_titulo: g.girado ? g.premio_titulo : null,
      valor_premio: g.girado ? g.valor_premio : null,
      ganhou: g.girado ? !!g.premio_titulo : null,
      cor_sorteada: g.girado ? (g.cor_sorteada || null) : null,
      pago_dobro: g.girado ? !!g.pago_dobro : false
    }));
    // Valores de prêmio possíveis (só pra decorar a roda visualmente) — nunca revela qual posição
    // do pool é a vencedora, só os VALORES que existem em prêmios ainda disponíveis nesse sorteio.
    let premios_possiveis = [];
    if (pedido.sorteio_id) {
      const { data: premiosData } = await supabase.from('bilhetes_premiados').select('valor_premio').eq('sorteio_id', pedido.sorteio_id).eq('tipo', 'roleta').eq('status', 'disponivel');
      premios_possiveis = [...new Set((premiosData || []).map(p => p.valor_premio).filter(Boolean))].slice(0, 6);
    }
    return ok(res, { giros: publico, premios_possiveis });
  } catch (err) { console.error('GET pedidos/:token/roletas', err); return fail(res); }
});

// Converte "R$ 50,00" -> 50 e formata de volta, pra dobrar o prêmio com segurança no servidor
// (nunca no navegador — é aqui que o valor final fica gravado e é o que vale pra pagamento).
function parseValorMoedaBR(str) {
  if (!str) return null;
  const limpo = String(str).replace(/[^\d.,]/g, '');
  if (!limpo) return null;
  const normalizado = limpo.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const num = parseFloat(normalizado);
  return isNaN(num) ? null : num;
}
function formatarValorMoedaBR(num) {
  return num.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "Gira" um giro específico — o resultado (ganhou/não ganhou) já estava determinado desde a
// aprovação do pagamento; aqui só revelamos. A COR onde a bolinha cai (verde/vermelho/preto) é
// sorteada agora, no servidor — nunca no navegador — porque o verde paga o prêmio em dobro, e essa
// decisão precisa ficar registrada de forma confiável (pra vocês saberem quanto pagar de verdade).
app.post('/api/public/roletas/:giroId/girar', async (req, res) => {
  try {
    const { data: giro } = await supabase.from('roleta_giros').select('*').eq('id', req.params.giroId).maybeSingle();
    if (!giro) return res.status(404).json({ error: 'Giro não encontrado' });
    if (giro.girado) {
      return ok(res, { premio_titulo: giro.premio_titulo, valor_premio: giro.valor_premio, ganhou: !!giro.premio_titulo, cor_sorteada: giro.cor_sorteada || null });
    }

    const corEscolhida = ['vermelho', 'preto', 'verde'].includes(req.body?.cor_escolhida) ? req.body.cor_escolhida : null;
    const ganhou = !!giro.premio_titulo;
    let corSorteada, valorFinal = giro.valor_premio, pagoDobro = false, quase = false;

    if (ganhou) {
      // Ganhou de verdade — a bolinha cai EXATAMENTE na cor que a pessoa escolheu (não é sorteio,
      // é uma entrega garantida — faz sentido parar onde ela apontou). Só quando ela escolheu o
      // próprio verde é que o prêmio sai em dobro; escolher vermelho/preto não muda o valor.
      corSorteada = corEscolhida || (Math.random() < 0.2 ? 'verde' : (Math.random() < 0.5 ? 'vermelho' : 'preto'));
      if (corSorteada === 'verde') {
        const valorNum = parseValorMoedaBR(giro.valor_premio);
        if (valorNum !== null) { valorFinal = formatarValorMoedaBR(valorNum * 2); pagoDobro = true; }
      }
    } else {
      // Perdeu — verifica se essa é a última roleta desse pedido ainda por girar (ou a única)
      const { count } = await supabase.from('roleta_giros').select('id', { count: 'exact', head: true }).eq('pedido_id', giro.pedido_id).eq('girado', false).neq('id', giro.id);
      const ehUltima = (count || 0) === 0;
      if (ehUltima && corEscolhida) {
        // Última (ou única) roleta — cai numa cor diferente da escolhida, pra dar a sensação de
        // "quase": o navegador vai fazer a bolinha parar bem do lado da cor que a pessoa escolheu.
        const outras = ['verde', 'vermelho', 'preto'].filter(c => c !== corEscolhida);
        corSorteada = outras[Math.floor(Math.random() * outras.length)];
        quase = true;
      } else if (corEscolhida) {
        corSorteada = ['verde', 'vermelho', 'preto'].filter(c => c !== corEscolhida)[Math.floor(Math.random() * 2)];
      } else {
        corSorteada = ['verde', 'vermelho', 'preto'][Math.floor(Math.random() * 3)];
      }
    }

    await supabase.from('roleta_giros').update({
      girado: true, girado_em: new Date().toISOString(), cor_sorteada: corSorteada, pago_dobro: pagoDobro, valor_premio: valorFinal
    }).eq('id', giro.id);

    if (giro.bilhete_premiado_id) {
      await supabase.from('bilhetes_premiados').update({
        status: 'reivindicada', usuario_id: giro.usuario_id, pedido_id: giro.pedido_id, reivindicada_em: new Date().toISOString()
      }).eq('id', giro.bilhete_premiado_id).eq('status', 'disponivel');
    }

    return ok(res, { premio_titulo: giro.premio_titulo, valor_premio: valorFinal, ganhou, cor_sorteada: corSorteada, pago_dobro: pagoDobro, quase });
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
app.post('/api/public/usuarios/verificar', limitePublicoSensivel, async (req, res) => {
  try {
    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const sorteio_id = req.body?.sorteio_id || null;
    if (!telefone) return fail(res, 'Telefone é obrigatório', 400);
    const { data: usuario } = await supabase.from('usuarios').select('id, nome_completo, email, cpf, endereco').eq('telefone', telefone).maybeSingle();
    if (!usuario) return ok(res, { existe: false, ja_comprou_este_sorteio: false });

    let ja_comprou_este_sorteio = false;
    if (sorteio_id) {
      const { count } = await supabase.from('pedidos').select('*', { head: true, count: 'exact' }).eq('user_id', usuario.id).eq('sorteio_id', sorteio_id).eq('status', 'pago');
      ja_comprou_este_sorteio = Number(count || 0) > 0;
    }

    return ok(res, {
      existe: true, nome_completo: usuario.nome_completo,
      tem_email: !!usuario.email, tem_cpf: !!usuario.cpf, tem_endereco: !!usuario.endereco,
      ja_comprou_este_sorteio
    });
  } catch (err) { console.error('POST usuarios/verificar', err); return fail(res); }
});

// ⭐ UPSELL: decide qual oferta mostrar na hora de confirmar a compra — a primeira cadastrada
// (na etapa certa: 1ª compra ou 2ª em diante) cujo valor fique ACIMA do que a pessoa já está
// levando. Se não tiver nenhuma acima, não mostra nada.
app.get('/api/public/upsell/:sorteioId', limitePublicoSensivel, async (req, res) => {
  try {
    const { sorteioId } = req.params;
    const valorAtual = Number(req.query.valor_atual || 0);
    const telefone = String(req.query.telefone || '').replace(/\D/g, '');

    let etapa = 'primeira_compra';
    if (telefone) {
      const { data: usuario } = await supabase.from('usuarios').select('id').eq('telefone', telefone).maybeSingle();
      if (usuario) {
        const { count } = await supabase.from('pedidos').select('*', { head: true, count: 'exact' }).eq('user_id', usuario.id).eq('sorteio_id', sorteioId).eq('status', 'pago');
        if (Number(count || 0) > 0) etapa = 'segunda_compra_em_diante';
      }
    }

    const { data: ofertas } = await supabase.from('upsell_ofertas').select('*').eq('sorteio_id', sorteioId).eq('etapa', etapa).eq('ativo', true).order('preco_promocional', { ascending: true });
    const oferta = (ofertas || []).find(o => Number(o.preco_promocional) > valorAtual) || null;
    return ok(res, { oferta, etapa });
  } catch (err) { console.error('GET upsell', err); return fail(res); }
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
  // ⚡ Antes, só limpava espaço/quebra de linha SE o valor começasse com "bearer " — mas é super
  // comum colar uma credencial no Render (ou em qualquer campo de configuração) com um espaço ou
  // quebra de linha escondida no final, sem começar com "bearer" nenhum. Isso "quebra" o cabeçalho
  // de autorização por dentro, e o Mercado Pago recusa dizendo que a autorização "não está presente"
  // — mesmo com o token certo configurado. Agora limpa SEMPRE, não só nesse caso específico.
  ACCESS_TOKEN = ACCESS_TOKEN.trim();
  if (ACCESS_TOKEN.toLowerCase().startsWith('bearer ')) ACCESS_TOKEN = ACCESS_TOKEN.slice(7).trim();
  console.log(`[MP] Token carregado — tamanho: ${ACCESS_TOKEN.length} caracteres, começa com: "${ACCESS_TOKEN.slice(0, 8)}..."`);

  const API_URL = (process.env.MERCADOPAGO_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, '');
  const emailValido = (usuario.email && usuario.email.includes('@') && usuario.email.length > 5) ? usuario.email : `c${usuario.telefone.replace(/\D/g, '')}@email.com`;
  // ⚡ Usa o CPF real da pessoa (quando o sorteio coleta isso no checkout) em vez de sempre inventar
  // um CPF aleatório — mandar um CPF que não é de ninguém de verdade é um motivo comum do Mercado
  // Pago recusar o pagamento no antifraude deles. Só cai pro CPF gerado se realmente não tiver um
  // CPF real disponível (sorteio que não pede CPF no checkout).
  const cpfLimpoUsuario = usuario.cpf ? String(usuario.cpf).replace(/\D/g, '') : '';
  // ⚡ Só usa o CPF real se ele for matematicamente válido de verdade (dígitos verificadores
  // batem) — um CPF digitado errado (ou de teste, tipo "111.111.111-11") faz o Mercado Pago
  // recusar o pedido inteiro. Nesse caso, cai pro CPF gerado (sempre válido) em vez de travar
  // a compra por causa de um dado que a pessoa digitou errado.
  const cpfEnvio = cpfEhValido(cpfLimpoUsuario) ? cpfLimpoUsuario : gerarCpfValido();

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

    if (!resp.ok) {
      // ⚡ Antes, um erro aqui só virava "não retornou pagamento" sem detalhe nenhum — impossível
      // saber o motivo real (token errado, conta não habilitada, CPF recusado, etc.). Agora o motivo
      // exato que o Mercado Pago mandou fica registrado no log do Render.
      let corpoErro = '';
      try { corpoErro = await resp.text(); } catch {}
      console.error(`❌ Mercado Pago recusou o pagamento (HTTP ${resp.status}):`, corpoErro);
      return null;
    }
    const data = await resp.json();
    if (data.id && data.point_of_interaction?.transaction_data?.qr_code) {
      // ⚡ O Mercado Pago manda o QR code como base64 "cru", sem o prefixo que o navegador precisa
      // pra reconhecer aquilo como uma imagem (senão o <img> fica com endereço inválido e não
      // mostra nada — era exatamente esse o motivo do QR code não aparecer, mesmo o Pix copia-e-
      // cola funcionando normalmente, já que esse não depende desse prefixo).
      const qrCru = data.point_of_interaction.transaction_data.qr_code_base64 || '';
      const qrComPrefixo = qrCru && !qrCru.startsWith('data:') ? `data:image/png;base64,${qrCru}` : qrCru;
      return { gateway_payment_id: String(data.id), pix_copia_cola: data.point_of_interaction.transaction_data.qr_code, pix_qr_code_base64: qrComPrefixo, provider: 'mercadopago' };
    }
    console.error('❌ Mercado Pago respondeu OK mas sem QR code de Pix:', JSON.stringify(data));
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

async function gerarCotasUnicas(pedido, opcoes = {}) {
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

    // Chance em Dobro: se o pedido foi feito dentro de uma janela ativa, dobra a quantidade de cotas.
    // Pedidos criados manualmente pelo admin já decidem isso na hora (opcoes.pularChanceDobroAutomatica),
    // pra não correr o risco de dobrar duas vezes sem querer.
    if (!opcoes.pularChanceDobroAutomatica) {
      try {
        const { data: chancesDobro } = await supabase.from('chance_dobro').select('*').eq('sorteio_id', sorteio_id).eq('ativo', true);
        const criadoEm = pedido.created_at || new Date().toISOString();
        const teveChanceDobro = (chancesDobro || []).some(c => criadoEm >= c.data_inicio && criadoEm <= c.data_fim);
        if (teveChanceDobro) bonusCotas += Number(pedido.quantidade_cotas || 0);
      } catch (err) { console.error('Erro ao checar chance em dobro', err); }
    }

    const totalCotas = Number(sorteio.total_cotas) || 1000000;
    const nowISO = new Date().toISOString();

    const [bloqRes, agRes, vendRes] = await Promise.all([
      supabase.from('cotas_bloqueadas').select('numero_cota').eq('sorteio_id', sorteio_id),
      supabase.from('cotas_agendadas').select('numero_cota, liberar_em, condicao_tipo, condicao_quantidade').eq('sorteio_id', sorteio_id),
      supabase.from('cotas').select('numero_cota').eq('sorteio_id', sorteio_id)
    ]);

    const qtdPedidoAtual = Number(pedido.quantidade_cotas || 0);
    const jaVendidas = new Set((vendRes.data || []).map(r => r.numero_cota));

    // Separa os agendamentos em dois grupos:
    // - agendadasAindaBloqueadas: data não chegou, OU chegou mas a condição de quantidade não bate
    //   com ESSE pedido (continua fora do sorteio aleatório pra ele, mas outro pedido pode se encaixar depois)
    // - prontasParaForcar: data já passou E (sem condição, OU a condição bate com ESSE pedido) — essas
    //   são ENTREGUES garantidamente nesta compra, não dependem de sorte no sorteio aleatório.
    const agendadasAindaBloqueadas = [];
    const prontasParaForcar = [];
    for (const r of (agRes.data || [])) {
      if (jaVendidas.has(r.numero_cota)) continue; // já foi entregue antes (não deveria sobrar agendamento, mas por segurança)
      const aindaNaoChegouAData = r.liberar_em && r.liberar_em > nowISO;
      if (aindaNaoChegouAData) { agendadasAindaBloqueadas.push(r); continue; }
      let bateCondicao = true;
      if (r.condicao_tipo === 'acima') bateCondicao = qtdPedidoAtual > Number(r.condicao_quantidade);
      if (r.condicao_tipo === 'abaixo') bateCondicao = qtdPedidoAtual < Number(r.condicao_quantidade);
      if (bateCondicao) prontasParaForcar.push(r);
      else agendadasAindaBloqueadas.push(r);
    }
    // A mais antiga programada tem prioridade se houver mais de uma pronta ao mesmo tempo.
    prontasParaForcar.sort((a, b) => String(a.liberar_em).localeCompare(String(b.liberar_em)));

    const invalidos = new Set([
      ...(bloqRes.data || []).map(r => r.numero_cota),
      ...agendadasAindaBloqueadas.map(r => r.numero_cota),
      ...jaVendidas
    ]);

    const quantidade = Number(pedido.quantidade_cotas || 0) + bonusCotas;
    const rows = [];

    // ⚡ Entrega garantida: as cotas agendadas que já bateram a data (e a condição, se houver) entram
    // DIRETO nessa compra — não dependem de sorte no sorteio aleatório abaixo.
    const agendamentosForcadosNestaCompra = [];
    for (const ag of prontasParaForcar) {
      if (rows.length >= quantidade) break;
      if (invalidos.has(ag.numero_cota)) continue; // segurança, não deveria acontecer
      rows.push({ sorteio_id, pedido_id: pedido.id, user_id, numero_cota: ag.numero_cota, created_at: new Date().toISOString() });
      invalidos.add(ag.numero_cota);
      agendamentosForcadosNestaCompra.push(ag);
    }

    let attempts = 0;
    const restantesLivres = totalCotas - invalidos.size;
    const faltam = quantidade - rows.length;
    // ⚡ Chutar um número aleatório e conferir se está livre fica cada vez mais lento (ou nunca
    // termina) conforme a "sobra" de números livres vai ficando pequena perto da quantidade pedida
    // — é a diferença entre "achar uma agulha rara" e "sortear de uma caixa cheia". Quando a sobra
    // está apertada (menos de 5x o que falta gerar), listamos de uma vez só os números realmente
    // livres e sorteamos direto dessa lista — sempre rápido, sempre termina. Só não fazemos isso pra
    // totais gigantescos (o custo de listar tudo também cresce, então mantemos o sorteio direto
    // quando a sobra é folgada, que já é rápido nesse caso).
    if (faltam > 0 && totalCotas <= 2_000_000 && restantesLivres > 0 && restantesLivres < faltam * 5) {
      const livres = [];
      for (let i = 0; i < totalCotas; i++) {
        const numero = padCota(i, totalCotas);
        if (!invalidos.has(numero)) livres.push(numero);
      }
      const quantosPegar = Math.min(faltam, livres.length);
      for (let i = 0; i < quantosPegar; i++) {
        const j = i + Math.floor(Math.random() * (livres.length - i));
        [livres[i], livres[j]] = [livres[j], livres[i]];
        const numero = livres[i];
        rows.push({ sorteio_id, pedido_id: pedido.id, user_id, numero_cota: numero, created_at: new Date().toISOString() });
        invalidos.add(numero);
      }
    } else if (faltam > 0) {
      // ⚡ Antes, cada tentativa varria o array `rows` inteiro pra conferir duplicata (`rows.some(...)`)
      // — com poucas cotas isso nem se sentia, mas em compras de milhares de cotas isso virava uma
      // conta gigantesca (quadrática: quantidade × quantidade), e era isso que travava a geração em
      // compras grandes. Essa checagem no array era redundante: todo número aceito já entra no Set
      // `invalidos` na sequência — então só checar o Set (que é instantâneo) já é suficiente e 100%
      // seguro contra repetição, sem precisar mais do `.some()`.
      const maxAttempts = Math.max(faltam * 200, 20000);
      while (rows.length < quantidade && attempts < maxAttempts) {
        attempts++;
        const numeroInt = Math.floor(Math.random() * totalCotas);
        const numero = padCota(numeroInt, totalCotas);

        if (!invalidos.has(numero)) {
          rows.push({ sorteio_id, pedido_id: pedido.id, user_id, numero_cota: numero, created_at: new Date().toISOString() });
          invalidos.add(numero);
        }
      }
    }

    if (rows.length === 0) return [];

    // Insere em lote. Compras grandes (milhares de cotas) vão em pedaços menores, em paralelo — mais
    // rápido e evita esbarrar num limite de tamanho de requisição de uma inserção gigante só.
    // Se algum pedaço colidir com outra cota já inserida por um pagamento aprovado ao mesmo tempo
    // (protegido por UNIQUE INDEX no banco — veja o SQL), insere uma por uma só o que sobrou.
    let inserted = [];
    const TAMANHO_LOTE = 2000;
    if (rows.length <= TAMANHO_LOTE) {
      const { data: insertedBulk, error: bulkError } = await supabase.from('cotas').insert(rows).select('id, numero_cota');
      if (!bulkError && insertedBulk) inserted = insertedBulk;
      else {
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
    } else {
      // Compra grande — insere em pedaços de 2000, todos ao mesmo tempo (em paralelo), bem mais
      // rápido que um pedido só gigantesco.
      const lotes = [];
      for (let i = 0; i < rows.length; i += TAMANHO_LOTE) lotes.push(rows.slice(i, i + TAMANHO_LOTE));
      const resultadosLotes = await Promise.all(lotes.map(lote => supabase.from('cotas').insert(lote).select('id, numero_cota')));
      let houveErroEmAlgumLote = false;
      for (const r of resultadosLotes) {
        if (r.error) { houveErroEmAlgumLote = true; console.warn('⚠️ Erro num lote de inserção (provável corrida entre pagamentos simultâneos):', r.error.message); }
        else inserted.push(...(r.data || []));
      }
      if (houveErroEmAlgumLote) {
        // Só o que faltou entrar tenta de novo, uma cota por vez (bem mais raro, então tudo bem ser mais lento aqui)
        const numerosJaInseridos = new Set(inserted.map(r => r.numero_cota));
        const faltantes = rows.filter(r => !numerosJaInseridos.has(r.numero_cota));
        for (const row of faltantes) {
          let tentativas = 0;
          let ok = false;
          let candidato = row;
          while (!ok && tentativas < 50) {
            tentativas++;
            const { data: ins, error: insErr } = await supabase.from('cotas').insert(candidato).select('id, numero_cota').single();
            if (!insErr && ins) { inserted.push(ins); ok = true; }
            else {
              const novoNumero = padCota(Math.floor(Math.random() * totalCotas), totalCotas);
              candidato = { ...candidato, numero_cota: novoNumero };
            }
          }
        }
      }
    }
    if (inserted.length === 0) return [];

    // ⚡ Soma no contador pronto de cotas vendidas — é essa soma que deixa a leitura da página do
    // sorteio instantânea (lê um número já pronto, em vez de contar tudo de novo a cada visita).
    // Roda "por trás", sem atrasar a resposta pro comprador — se falhar por algum motivo raro, não
    // trava a compra, só fica pra sincronização de segurança da próxima leitura acertar de novo.
    supabase.rpc('incrementar_cotas_vendidas', { p_sorteio_id: sorteio_id, p_quantidade: inserted.length })
      .then(({ error }) => { if (error) console.error('Erro ao incrementar cotas_vendidas', error); });

    // As cotas agendadas que realmente entraram nesta compra saem da fila de agendamentos — já
    // foram entregues, não podem ser prometidas de novo pra outra pessoa no futuro.
    if (agendamentosForcadosNestaCompra.length) {
      const numerosInseridos = new Set(inserted.map(r => r.numero_cota));
      const idsParaRemover = agendamentosForcadosNestaCompra.filter(ag => numerosInseridos.has(ag.numero_cota)).map(ag => ag.id);
      if (idsParaRemover.length) {
        await supabase.from('cotas_agendadas').delete().in('id', idsParaRemover);
      }
    }

    await safeUpdatePedidos(pedido.id, { cotas_geradas: 1, cotas_array: inserted.map(r => r.numero_cota), status: 'pago', updated_at: new Date().toISOString() });

    // Verifica se alguma das cotas geradas bate com um BILHETE premiado ainda disponível
    // (a roleta usa números de cota reais também, mas é tratada à parte — veja atribuirGirosRoleta).
    //
    // ⚡ Antes, isso mandava a lista INTEIRA de números gerados (podendo ter milhares numa compra
    // grande) dentro de um filtro pro banco — uma URL/consulta gigantesca, que crescia junto com o
    // tamanho da compra e travava tudo. Só que os PRÊMIOS configurados são sempre pouquíssimos (uns
    // punhados, não milhares) — então é muito mais rápido buscar só os prêmios disponíveis (poucos)
    // e comparar na memória contra os números já gerados, em vez do caminho inverso.
    const numeros = inserted.map(r => r.numero_cota);
    const numerosSet = new Set(numeros);
    try {
      const { data: premiosDisponiveisBilhete } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', sorteio_id).eq('tipo', 'bilhete').eq('status', 'disponivel').eq('ativo', true);
      const possiveisPremios = (premiosDisponiveisBilhete || []).filter(p => numerosSet.has(p.numero_cota));
      for (const premio of possiveisPremios) {
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
  console.log(`[roleta] Pedido ${pedido?.id} — sorteio_id=${sorteio_id}, roleta_ativada=${sorteio?.roleta_ativada}, roleta_giros_por_compra=${sorteio?.roleta_giros_por_compra}`);
  if (!sorteio || !sorteio.roleta_ativada) {
    console.log(`[roleta] Pedido ${pedido?.id} — SAIU CEDO: sorteio não encontrado ou roleta_ativada é falso.`);
    return;
  }

  const girosGarantidos = Number(sorteio.roleta_giros_por_compra ?? 1);
  let qtdGiros = girosGarantidos;

  // Os combos de "a cada X títulos, receba Y roletas" valem em dois casos: quando o cliente
  // comprou clicando especificamente num combo, OU quando essa já é a 2ª compra dele (ou mais)
  // pra esse sorteio — a partir daí, os combos passam a valer sozinhos, mesmo sem clicar.
  let ehSegundaCompraOuMais = false;
  if (!pedido.veio_de_combo_roleta) {
    const { count } = await supabase.from('pedidos').select('*', { head: true, count: 'exact' }).eq('user_id', user_id).eq('sorteio_id', sorteio_id).eq('status', 'pago').neq('id', pedido.id);
    ehSegundaCompraOuMais = Number(count || 0) > 0;
  }
  console.log(`[roleta] Pedido ${pedido?.id} — veio_de_combo_roleta=${pedido?.veio_de_combo_roleta}, ehSegundaCompraOuMais=${ehSegundaCompraOuMais}, quantidade_cotas=${pedido?.quantidade_cotas}`);
  if (pedido.veio_de_combo_roleta || ehSegundaCompraOuMais) {
    const { data: tiers } = await supabase.from('roleta_tiers').select('*').eq('sorteio_id', sorteio_id).order('minimo_cotas', { ascending: false });
    console.log(`[roleta] Pedido ${pedido?.id} — tiers configurados:`, JSON.stringify(tiers));
    const qtdComprada = Number(pedido.quantidade_cotas || 0);
    const tierAlcançado = (tiers || []).find(t => qtdComprada >= Number(t.minimo_cotas));
    console.log(`[roleta] Pedido ${pedido?.id} — tier alcançado:`, JSON.stringify(tierAlcançado));
    if (tierAlcançado) qtdGiros = Math.max(girosGarantidos, Number(tierAlcançado.quantidade_giros));
  }
  // Se o pedido veio com bônus de roleta de uma oferta de Upsell, garante pelo menos essa quantidade
  if (Number(pedido.giros_bonus_upsell) > 0) qtdGiros = Math.max(qtdGiros, Number(pedido.giros_bonus_upsell));
  console.log(`[roleta] Pedido ${pedido?.id} — qtdGiros calculado = ${qtdGiros} (garantidos=${girosGarantidos})`);

  // Verifica se alguma das cotas REAIS geradas agora bate com um prêmio de roleta ainda disponível.
  // Mesma otimização de cima: busca só os prêmios (poucos) e compara na memória, em vez de mandar
  // a lista inteira de números gerados (que numa compra grande vira uma consulta gigantesca).
  const numerosGeradosSet = new Set(numerosGerados);
  const { data: premiosRoletaDisponiveis } = await supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', sorteio_id).eq('tipo', 'roleta').eq('status', 'disponivel');
  const premioAcertado = (premiosRoletaDisponiveis || []).find(p => numerosGeradosSet.has(p.numero_cota)) || null;

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

  if (qtdGiros <= 0) {
    console.log(`[roleta] Pedido ${pedido?.id} — SAIU: qtdGiros é 0 ou menos, nenhum giro será criado.`);
    return;
  }

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
  await supabase.from('roleta_giros').insert(novasLinhas).then(({ error }) => {
    if (error) console.error(`[roleta] Pedido ${pedido?.id} — ERRO ao inserir giros:`, error.message);
    else console.log(`[roleta] Pedido ${pedido?.id} — ${novasLinhas.length} giro(s) inserido(s) com sucesso.`);
  });
}

// --- API PEDIDOS PUBLIC (com suporte a funil_id) ---
app.post('/api/public/pedidos/iniciar', limitePublicoSensivel, async (req, res) => {
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
    let giros_bonus_upsell = 0;
    const { data: promoMatch } = await supabase.from('promocoes').select('*').eq('sorteio_id', sorteio_id).eq('ativo', true).eq('quantidade_cotas', quantidade).maybeSingle();
    if (promoMatch) {
      valor_total = Number(promoMatch.preco_promocional);
      promocao_aplicada = promoMatch.titulo;
    } else {
      // Não bateu com nenhuma promoção "clássica" — confere se bate com uma oferta de Upsell
      // (preço e giros de roleta bônus sempre decididos aqui no servidor, nunca confiando no
      // que o navegador manda, por segurança).
      const { data: upsellMatch } = await supabase.from('upsell_ofertas').select('*').eq('sorteio_id', sorteio_id).eq('ativo', true).eq('quantidade_cotas', quantidade).order('preco_promocional', { ascending: true }).limit(1).maybeSingle();
      if (upsellMatch) {
        valor_total = Number(upsellMatch.preco_promocional);
        giros_bonus_upsell = Number(upsellMatch.quantidade_giros_roleta || 0);
        promocao_aplicada = 'Oferta especial';
      }
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
      token, user_id: usuario.id, sorteio_id, quantidade_cotas: quantidade, valor_total, status: 'aguardando', expira_em: expira, funil_id: funilValido, link_id, promocao_titulo: promocao_aplicada, veio_de_combo_roleta: !!veio_de_combo_roleta || giros_bonus_upsell > 0, giros_bonus_upsell, created_at: new Date().toISOString()
    }).select().single();

    const pagamento = await criarPagamentoGateway(pedido, usuario);
    // ⚡ Corrige de uma vez por todas, pra QUALQUER gateway (Mercado Pago, Pay2m, Paggue, etc.):
    // o QR code do PIX vem como base64 "cru" da maioria das APIs de pagamento, e o navegador só
    // consegue mostrar isso como imagem se vier com o prefixo "data:image/png;base64,". Sem isso,
    // o <img> fica com endereço inválido e não aparece nada — mesmo o Pix copia-e-cola funcionando
    // normalmente (por isso um funcionava e o outro não).
    const qrCodeNormalizado = pagamento.pix_qr_code_base64 && !pagamento.pix_qr_code_base64.startsWith('data:')
      ? `data:image/png;base64,${pagamento.pix_qr_code_base64}`
      : (pagamento.pix_qr_code_base64 || null);
    await supabase.from('pedidos').update({
      gateway_payment_id: pagamento.gateway_payment_id,
      pix_copia_cola: pagamento.pix_copia_cola || null,
      pix_qr_code_base64: qrCodeNormalizado,
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
        pix_qr_code_base64: qrCodeNormalizado
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
    const { data: links } = await supabase.from('links_rastreamento').select('*, funis(nome, slug)').eq('sorteio_id', sorteio_id).not('codigo', 'like', 'auto-%').order('cliques', { ascending: false });
    const { data: sorteio } = await supabase.from('sorteios').select('slug').eq('id', sorteio_id).maybeSingle();

    const resultados = [];
    for (const link of (links || [])) {
      const { data: pedidos } = await supabase.from('pedidos').select('valor_total, status, expira_em, user_id').eq('link_id', link.id);
      const nowISOLink = new Date().toISOString();
      const pagos = (pedidos || []).filter(p => p.status === 'pago');
      const pendentes = (pedidos || []).filter(p => p.status === 'aguardando' && (!p.expira_em || p.expira_em >= nowISOLink));
      const faturamento = pagos.reduce((s, p) => s + Number(p.valor_total || 0), 0);
      const pendente = pendentes.reduce((s, p) => s + Number(p.valor_total || 0), 0);
      const total_pedidos = (pedidos || []).length;
      const total_clientes = new Set(pagos.map(p => p.user_id).filter(Boolean)).size;
      const ticket_medio = total_clientes > 0 ? faturamento / total_clientes : 0;
      const conversao = link.cliques > 0 ? (pagos.length / link.cliques) * 100 : 0;
      const caminho = link.funis?.slug ? `/sorteio/${sorteio?.slug || ''}/${link.funis.slug}` : `/sorteio/${sorteio?.slug || ''}`;
      resultados.push({
        ...link,
        url: link.codigo.startsWith('auto-') ? null : `${DOMINIO_PUBLICO_SERVIDOR}${caminho}?lk=${link.codigo}`,
        cliques: link.cliques || 0,
        pedidos_pagos: pagos.length,
        total_pedidos,
        total_clientes,
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
    let q = supabase.from('links_rastreamento').select('*, sorteios(nome, slug)').not('codigo', 'like', 'auto-%');
    if (sorteio_id && sorteio_id !== 'todos') q = q.eq('sorteio_id', sorteio_id);
    const { data: links } = await q.order('cliques', { ascending: false });

    const resultados = [];
    for (const link of (links || [])) {
      let acessosQ = supabase.from('acessos_log').select('*', { head: true, count: 'exact' }).eq('link_id', link.id);
      let pedidosQ = supabase.from('pedidos').select('valor_total, status, user_id').eq('link_id', link.id);
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
      const total_clientes = new Set(pagos.map(p => p.user_id).filter(Boolean)).size;
      const ticket_medio = total_clientes > 0 ? faturamento / total_clientes : 0;
      const conversao = cliques > 0 ? (pagos.length / cliques) * 100 : 0;
      // Link oficial (auto-direto do sorteio, sem funil) tem URL limpa; links criados manualmente usam ?lk=
      let url = null;
      const slug = link.sorteios?.slug;
      if (slug) {
        if (link.codigo === 'auto-direto') url = `${DOMINIO_PUBLICO_SERVIDOR}/sorteio/${slug}`;
        else if (!link.codigo.startsWith('auto-')) url = `${DOMINIO_PUBLICO_SERVIDOR}/sorteio/${slug}?lk=${link.codigo}`;
      }
      resultados.push({ ...link, url, cliques, pedidos_pagos: pagos.length, total_clientes, expirados, faturamento, pendente, ticket_medio, conversao });
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
    let pedidosQ = supabase.from('pedidos').select('valor_total, status, created_at, expira_em, user_id').eq('link_id', link.id);
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
    const total_clientes = new Set(pagos.map(p => p.user_id).filter(Boolean)).size;

    return ok(res, {
      link, serie,
      acessos: totalAcessos, pedidos_pagos: pagos.length, pendentes: pendentes.length, expirados: expirados.length,
      faturamento, pendente, total_clientes, ticket_medio: total_clientes > 0 ? faturamento / total_clientes : 0,
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

// ---------------- UPSELL (aumentar ticket médio na hora de confirmar a compra) ----------------
app.get('/api/admin/sorteios/:id/upsell-ofertas', ensureAdminAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('upsell_ofertas').select('*').eq('sorteio_id', req.params.id).order('preco_promocional', { ascending: true });
    return ok(res, { lista: data || [] });
  } catch (e) { return fail(res); }
});
app.post('/api/admin/sorteios/:id/upsell-ofertas', ensureAdminAuth, async (req, res) => {
  try {
    const { etapa, quantidade_cotas, preco_promocional, quantidade_giros_roleta, ativo } = req.body || {};
    if (!quantidade_cotas || !preco_promocional) return fail(res, 'Preencha a quantidade e o preço promocional', 400);
    if (!['primeira_compra', 'segunda_compra_em_diante'].includes(etapa)) return fail(res, 'Etapa inválida', 400);
    const { data, error } = await supabase.from('upsell_ofertas').insert({
      sorteio_id: req.params.id, etapa,
      quantidade_cotas: parseInt(quantidade_cotas), preco_promocional: parseFloat(preco_promocional),
      quantidade_giros_roleta: etapa === 'segunda_compra_em_diante' ? (parseInt(quantidade_giros_roleta) || 0) : 0,
      ativo: ativo !== false
    }).select().single();
    if (error) return fail(res, error.message);
    return ok(res, { oferta: data });
  } catch (e) { return fail(res); }
});
app.put('/api/admin/upsell-ofertas/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { quantidade_cotas, preco_promocional, quantidade_giros_roleta, ativo } = req.body || {};
    const payload = {};
    if (quantidade_cotas !== undefined) payload.quantidade_cotas = parseInt(quantidade_cotas);
    if (preco_promocional !== undefined) payload.preco_promocional = parseFloat(preco_promocional);
    if (quantidade_giros_roleta !== undefined) payload.quantidade_giros_roleta = parseInt(quantidade_giros_roleta) || 0;
    if (ativo !== undefined) payload.ativo = !!ativo;
    const { error } = await supabase.from('upsell_ofertas').update(payload).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    return ok(res);
  } catch (e) { return fail(res); }
});
app.delete('/api/admin/upsell-ofertas/:id', ensureAdminAuth, async (req, res) => {
  try { const { error } = await supabase.from('upsell_ofertas').delete().eq('id', req.params.id); if (error) return fail(res, error.message); return ok(res); } catch (e) { return fail(res); }
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
    const bruto = req.body?.roleta_giros_por_compra;
    const valor = parseInt(bruto);
    // 🐛 Antes, se o valor não viesse certinho, salvava 0 silenciosamente — e 0 giros garantidos
    // quebra a promessa de "todo mundo que compra tem direito a pelo menos 1 giro". Agora recusa
    // valores inválidos em vez de corromper o dado sem avisar.
    if (isNaN(valor) || valor < 0) return fail(res, 'Digite um número válido (0 ou mais).', 400);
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

    let qt = supabase.from('pedidos').select('id').eq('status', 'pago');
    qt = baseFilter(qt);
    const { data: all } = await qt;

    const faturamento = (paid || []).reduce((s, p) => s + Number(p.valor_total || 0), 0);
    const pendente = (pend || []).reduce((s, p) => s + Number(p.valor_total || 0), 0);
    const total_pedidos = (all || []).length;
    const total_clientes = new Set((paid || []).map(p => p.user_id).filter(Boolean)).size;
    const ticket_medio = total_clientes > 0 ? (faturamento / total_clientes) : 0;

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
      let qp = supabase.from('pedidos').select('valor_total, status, expira_em, user_id').eq('sorteio_id', s.id);
      if (start_date) qp = qp.gte('created_at', start_date);
      if (end_date) qp = qp.lte('created_at', end_date);
      const { data: pedidos } = await qp;
      const nowISORel = new Date().toISOString();
      const pagos = (pedidos || []).filter(p => p.status === 'pago');
      const pendentes = (pedidos || []).filter(p => p.status === 'aguardando' && (!p.expira_em || p.expira_em >= nowISORel));
      const faturamento = pagos.reduce((s2, p) => s2 + Number(p.valor_total || 0), 0);
      const pendente = pendentes.reduce((s2, p) => s2 + Number(p.valor_total || 0), 0);
      const total_clientes = new Set(pagos.map(p => p.user_id).filter(Boolean)).size;
      const ticket_medio = total_clientes > 0 ? faturamento / total_clientes : 0;

      let qa = supabase.from('acessos_log').select('*', { head: true, count: 'exact' }).eq('sorteio_id', s.id);
      if (start_date) qa = qa.gte('created_at', start_date);
      if (end_date) qa = qa.lte('created_at', end_date);
      const { count: acessos } = await qa;

      const conversao = (acessos || 0) > 0 ? (pagos.length / acessos) * 100 : 0;
      resultados.push({ sorteio_id: s.id, nome: s.nome, acessos: acessos || 0, total_pedidos: pagos.length, total_clientes, faturamento, pendente, ticket_medio, conversao });
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
    invalidarCacheConfig();
    await loadConfigToEnv();
    return ok(res, { msg: 'Configurações salvas!' });
  } catch (e) { return fail(res); }
});

// ⚡ Pixels adicionais do Meta — lista, adiciona e remove. Todos os que estiverem "ativos" aqui
// recebem exatamente os mesmos eventos e valores que o pixel principal já recebe, em todas as
// páginas (sorteio, funil, checkout) — sem precisar mexer em mais nada quando adiciona um novo.
app.get('/api/admin/pixels-meta-extras', ensureAdminAuth, async (_req, res) => {
  try {
    const { data, error } = await supabase.from('pixels_meta_extras').select('*').order('created_at', { ascending: false });
    if (error) return fail(res, 'Erro ao listar pixels');
    return res.json(data || []);
  } catch (e) { return fail(res); }
});

app.post('/api/admin/pixels-meta-extras', ensureAdminAuth, async (req, res) => {
  try {
    const { nome, pixel_id } = req.body || {};
    const pixelLimpo = String(pixel_id || '').trim();
    if (!pixelLimpo) return res.status(400).json({ error: 'Informe o ID do pixel.' });
    if (!/^\d+$/.test(pixelLimpo)) return res.status(400).json({ error: 'O ID do pixel do Meta só tem números (confere se não colou nada a mais).' });
    // ⚡ Bloqueia cadastro duplicado já na origem — nem repetido dentro da lista de extras, nem
    // igual ao pixel principal já configurado. Evita qualquer chance de um pixel receber o mesmo
    // evento em dobro por causa de um cadastro duplicado sem querer.
    const cfgAtual = await fetchConfigFromDB();
    const pixelPrincipal = cfgAtual.FACEBOOK_PIXEL_ID || process.env.FACEBOOK_PIXEL_ID || '';
    if (pixelLimpo === String(pixelPrincipal).trim()) {
      return res.status(400).json({ error: 'Esse ID já é o seu pixel principal — não precisa cadastrar de novo aqui.' });
    }
    const { data: jaExiste } = await supabase.from('pixels_meta_extras').select('id').eq('pixel_id', pixelLimpo).maybeSingle();
    if (jaExiste) return res.status(400).json({ error: 'Esse pixel já está cadastrado na lista.' });
    const { error } = await supabase.from('pixels_meta_extras').insert({ nome: nome || null, pixel_id: pixelLimpo, ativo: true });
    if (error) return fail(res, error.message);
    invalidarCachePixelsExtras();
    return ok(res, { msg: 'Pixel adicionado!' });
  } catch (e) { return fail(res); }
});

app.patch('/api/admin/pixels-meta-extras/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { ativo } = req.body || {};
    const { error } = await supabase.from('pixels_meta_extras').update({ ativo: !!ativo }).eq('id', req.params.id);
    if (error) return fail(res, error.message);
    invalidarCachePixelsExtras();
    return ok(res);
  } catch (e) { return fail(res); }
});

app.delete('/api/admin/pixels-meta-extras/:id', ensureAdminAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('pixels_meta_extras').delete().eq('id', req.params.id);
    if (error) return fail(res, error.message);
    invalidarCachePixelsExtras();
    return ok(res);
  } catch (e) { return fail(res); }
});

app.post('/api/admin/upload-logo', ensureAdminAuth, upload.single('logo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return fail(res, 'Arquivo não enviado', 400);
    const { buffer: bufferComprimido, mimetype: mimeComprimido, extensao } = await comprimirImagem(file.buffer, file.mimetype, 400);
    const nomeBase = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_').replace(/\.[^.]+$/, '');
    const safeName = extensao ? `${nomeBase}.${extensao}` : file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    const dest = `logos/${Date.now()}-${safeName}`;
    const { error } = await supabase.storage.from('logos').upload(dest, bufferComprimido, { contentType: mimeComprimido, upsert: true });
    if (error) return fail(res, error.message);
    const { data: pub } = supabase.storage.from('logos').getPublicUrl(dest);
    const publicURL = pub?.publicUrl;

    await supabase.from('configuracoes').upsert({ chave: 'LOGO_URL', valor: publicURL }, { onConflict: 'chave' });
    invalidarCacheConfig();
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
    // ⚡ Antes, isso fazia uma consulta de CONTAGEM separada pra CADA sorteio da lista, uma atrás da
    // outra — em painéis com muitos sorteios, isso demorava bastante. Como cotas_vendidas já vem
    // pronto na própria linha do sorteio (contador sempre atualizado a cada venda), nem precisa
    // mais perguntar nada a mais aqui.
    const results = (data || []).map(s => ({ ...s, cotas_vendidas: s.cotas_vendidas || 0 }));
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
      const { buffer: bufferComprimido, mimetype: mimeComprimido, extensao } = await comprimirImagem(file.buffer, file.mimetype);
      const nomeBase = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_').replace(/\.[^.]+$/, '');
      const safeName = extensao ? `${nomeBase}.${extensao}` : file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
      const dest = `${isEditing ? body.sorteio_id : 'new'}/${Date.now()}-${safeName}`;
      const { error } = await supabase.storage.from('sorteios').upload(dest, bufferComprimido, { contentType: mimeComprimido, upsert: true });
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

// 🆕 Cria um pedido manualmente pelo painel — pra vendas feitas fora do sistema (dinheiro na mão,
// combinado por fora, etc.) que o admin quer registrar como se tivesse sido uma compra normal.
// Já entra como "pago" na hora, com as cotas geradas de verdade.
// 🎯 Puxa uma cota específica pro pedido informado — se ela já pertencer a outro pedido, dá pra
// esse outro pedido um número novo aleatório no lugar (mantém a quantidade dele igual, só troca
// qual número representa uma das cotas). Devolve o número formatado que ficou pertencendo ao pedido.
async function puxarCotaEspecificaParaPedido(sorteioId, numeroCotaDesejado, pedidoDestino, totalCotas) {
  const numeroFormatado = padCota(numeroCotaDesejado, totalCotas);

  const { data: cotaExistente } = await supabase.from('cotas').select('*').eq('sorteio_id', sorteioId).eq('numero_cota', numeroFormatado).maybeSingle();

  if (cotaExistente) {
    if (cotaExistente.pedido_id === pedidoDestino.id) return numeroFormatado; // já é dele mesmo, nada a fazer
    // Já pertence a outro pedido — gera um número novo aleatório só pra essa cota específica dele,
    // liberando o número desejado.
    const { data: todasCotas } = await supabase.from('cotas').select('numero_cota').eq('sorteio_id', sorteioId);
    const { data: bloqueadas } = await supabase.from('cotas_bloqueadas').select('numero_cota').eq('sorteio_id', sorteioId);
    const ocupados = new Set([...(todasCotas || []).map(c => c.numero_cota), ...(bloqueadas || []).map(c => c.numero_cota)]);
    let novoNumero = null;
    let tentativas = 0;
    while (!novoNumero && tentativas < 5000) {
      tentativas++;
      const candidato = padCota(Math.floor(Math.random() * totalCotas), totalCotas);
      if (!ocupados.has(candidato)) novoNumero = candidato;
    }
    if (novoNumero) {
      await supabase.from('cotas').update({ numero_cota: novoNumero }).eq('id', cotaExistente.id);
    }
  }

  // Pega uma das cotas recém-geradas do pedido atual e troca ela pro número desejado
  const { data: cotasDoNovoPedido } = await supabase.from('cotas').select('id').eq('pedido_id', pedidoDestino.id).limit(1);
  if (cotasDoNovoPedido && cotasDoNovoPedido.length > 0) {
    await supabase.from('cotas').update({ numero_cota: numeroFormatado }).eq('id', cotasDoNovoPedido[0].id);
  }
  return numeroFormatado;
}

app.post('/api/admin/pedidos/criar-manual', ensureAdminAuth, async (req, res) => {
  try {
    const { sorteio_id, nome_completo, telefone, cpf, email, endereco, quantidade, valor_total_customizado, promocao_id, aplicar_chance_dobro, cota_especifica } = req.body || {};
    if (!sorteio_id || !nome_completo || !telefone) return fail(res, 'Sorteio, nome e telefone são obrigatórios', 400);

    const { data: sorteio } = await supabase.from('sorteios').select('*').eq('id', sorteio_id).maybeSingle();
    if (!sorteio) return fail(res, 'Sorteio não encontrado', 404);

    if (sorteio.coletar_cpf && !cpf) return fail(res, 'CPF é obrigatório para este sorteio', 400);
    if (sorteio.coletar_email && !email) return fail(res, 'E-mail é obrigatório para este sorteio', 400);
    if (sorteio.coletar_endereco && !endereco) return fail(res, 'Endereço é obrigatório para este sorteio', 400);

    // Acha ou cria o usuário/comprador, igual no fluxo normal de compra
    const telefoneLimpo = String(telefone).replace(/\D/g, '');
    const cpfLimpo = cpf ? String(cpf).replace(/\D/g, '') : null;
    const { data: usuarioExistente } = await supabase.from('usuarios').select('*').eq('telefone', telefoneLimpo).maybeSingle();
    let usuario = usuarioExistente;
    if (!usuario) {
      const { data: novo, error: nErr } = await supabase.from('usuarios').insert({ nome_completo, telefone: telefoneLimpo, email: email || null, cpf: cpfLimpo, endereco: endereco || null }).select().single();
      if (nErr) return fail(res, 'Erro ao criar usuário');
      usuario = novo;
    }

    // Calcula quantidade de cotas e valor — pode vir por quantidade OU por valor customizado
    let quantidadeCotas = Number(quantidade || 0);
    let valorTotal;
    let promocaoTitulo = null;

    if (promocao_id) {
      const { data: promo } = await supabase.from('promocoes').select('*').eq('id', promocao_id).eq('sorteio_id', sorteio_id).maybeSingle();
      if (!promo) return fail(res, 'Promoção não encontrada', 404);
      quantidadeCotas = Number(promo.quantidade_cotas);
      valorTotal = Number(promo.preco_promocional);
      promocaoTitulo = promo.titulo;
    } else if (valor_total_customizado !== undefined && valor_total_customizado !== null && valor_total_customizado !== '') {
      valorTotal = Number(valor_total_customizado);
      if (!quantidadeCotas) quantidadeCotas = Math.max(1, Math.round(valorTotal / Number(sorteio.preco_cota || 1)));
    } else {
      if (!quantidadeCotas) return fail(res, 'Informe a quantidade de títulos ou um valor', 400);
      valorTotal = quantidadeCotas * Number(sorteio.preco_cota || 0);
    }

    // Chance em Dobro: se o admin marcou pra aplicar nesse pedido, já soma aqui — direto, sem
    // depender de nenhuma verificação automática de data (evita duplicar o bônus sem querer).
    if (aplicar_chance_dobro) quantidadeCotas *= 2;

    const token = uuidv4();
    const { data: pedido, error: pedErro } = await supabase.from('pedidos').insert({
      token, user_id: usuario.id, sorteio_id, quantidade_cotas: quantidadeCotas, valor_total: valorTotal,
      status: 'pago', promocao_titulo: promocaoTitulo, criado_manualmente_admin: true, created_at: new Date().toISOString()
    }).select().single();
    if (pedErro || !pedido) return fail(res, 'Erro ao criar pedido');

    const numerosGerados = await gerarCotasUnicas(pedido, { pularChanceDobroAutomatica: true });

    let numerosFinais = numerosGerados.map(c => c.numero_cota);
    let cotaEspecificaAplicada = null;
    if (cota_especifica && numerosGerados.length > 0) {
      try {
        cotaEspecificaAplicada = await puxarCotaEspecificaParaPedido(sorteio_id, cota_especifica, pedido, Number(sorteio.total_cotas) || 1000000);
        if (cotaEspecificaAplicada) {
          // Atualiza a lista em memória com o número que realmente ficou — importante pra checagem
          // de prêmio da roleta logo abaixo já considerar a cota certa, não a aleatória antiga.
          numerosFinais = [cotaEspecificaAplicada, ...numerosFinais.slice(1)];
        }
      } catch (err) { console.error('Erro ao puxar cota específica', err); }
    }

    try { await atribuirGirosRoleta(sorteio_id, pedido, usuario.id, numerosFinais); } catch (err) { console.error('Erro ao atribuir giros de roleta (pedido manual)', err); }

    return ok(res, { pedido, cotas_geradas: numerosGerados.length, cota_especifica_aplicada: cotaEspecificaAplicada });
  } catch (e) { console.error('Erro ao criar pedido manual', e); return fail(res); }
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

// Diagnóstico: mostra o status REAL de uma cota agora mesmo — bloqueio permanente, agendamento
// (e se já liberou ou ainda não, e por quê), se já foi vendida, e se ela é um prêmio (bilhete
// premiado ou roleta) e o status desse prêmio. Existe pra você conseguir CONFERIR com certeza,
// sem depender de comprar de teste pra "ver se ganha" (que é probabilístico, não garantido).
app.get('/api/admin/sorteios/:id/verificar-cota', ensureAdminAuth, async (req, res) => {
  try {
    const { data: sorteioRef } = await supabase.from('sorteios').select('total_cotas').eq('id', req.params.id).maybeSingle();
    if (!sorteioRef) return fail(res, 'Sorteio não encontrado', 404);
    const numeroFormatado = padCota(String(req.query.numero || '').replace(/\D/g, ''), sorteioRef.total_cotas);

    const [{ data: bloqueio }, { data: agendamentos }, { data: vendida }, { data: premios }] = await Promise.all([
      supabase.from('cotas_bloqueadas').select('*').eq('sorteio_id', req.params.id).eq('numero_cota', numeroFormatado).maybeSingle(),
      supabase.from('cotas_agendadas').select('*').eq('sorteio_id', req.params.id).eq('numero_cota', numeroFormatado),
      supabase.from('cotas').select('numero_cota, user_id, pedido_id, created_at').eq('sorteio_id', req.params.id).eq('numero_cota', numeroFormatado).maybeSingle(),
      supabase.from('bilhetes_premiados').select('*').eq('sorteio_id', req.params.id).eq('numero_cota', numeroFormatado)
    ]);

    const nowISO = new Date().toISOString();
    const agendamentosComStatus = (agendamentos || []).map(a => {
      const aindaNaoChegouAData = a.liberar_em && a.liberar_em > nowISO;
      let bloqueadaAgora = aindaNaoChegouAData;
      let motivoTipo = aindaNaoChegouAData ? 'aguardando_data' : 'liberada';
      if (!aindaNaoChegouAData && a.condicao_tipo === 'acima') { bloqueadaAgora = true; motivoTipo = 'aguardando_condicao_acima'; }
      if (!aindaNaoChegouAData && a.condicao_tipo === 'abaixo') { bloqueadaAgora = true; motivoTipo = 'aguardando_condicao_abaixo'; }
      // motivo_tipo vai puro (sem data formatada) — o painel converte liberar_em pro fuso local
      // de quem está olhando, senão a data aparece "crua" em UTC e parece errada sem ser.
      return { ...a, bloqueada_agora: bloqueadaAgora, motivo_tipo: motivoTipo };
    });

    return ok(res, {
      numero: numeroFormatado,
      bloqueio_permanente: bloqueio || null,
      agendamentos: agendamentosComStatus,
      ja_vendida: vendida || null,
      premios: premios || []
    });
  } catch (e) { console.error('verificar-cota', e); return fail(res); }
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
    invalidarCacheConfig();
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

// 🔒 Confirma que a notificação de pagamento realmente veio do Mercado Pago (e não de alguém
// mandando uma requisição forjada tentando marcar um pedido como "pago" sem ter pago de verdade).
// Segue exatamente o algoritmo oficial deles: https://www.mercadopago.com.br/developers/.../webhooks
function verificarAssinaturaWebhookMP(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return { valido: null }; // ainda não configurado — ver aviso no changelog

  const assinatura = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];
  if (!assinatura || !requestId || !dataId) return { valido: false };

  const partes = String(assinatura).split(',').reduce((acc, parte) => {
    const [chave, valor] = parte.split('=');
    if (chave && valor) acc[chave.trim()] = valor.trim();
    return acc;
  }, {});
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!ts || !v1) return { valido: false };

  const template = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const calculada = crypto.createHmac('sha256', secret).update(template).digest('hex');
  return { valido: calculada === v1 };
}

app.post('/api/webhook/pagamento', async (req, res) => {
  try {
    let payload = req.body;
    if (Buffer.isBuffer(payload)) {
      try { payload = JSON.parse(payload.toString('utf8')); } catch { payload = {}; }
    }
    const paymentId = payload.id || payload.data?.id || payload['collection_id'] || null;
    if (!paymentId) return res.status(400).json({ error: 'no id found' });

    const { valido } = verificarAssinaturaWebhookMP(req, String(paymentId));
    if (valido === false) {
      console.warn('🚨 Webhook de pagamento com assinatura INVÁLIDA — recusado. paymentId:', paymentId);
      return res.status(401).json({ error: 'assinatura inválida' });
    }
    if (valido === null) {
      console.warn('⚠️ MP_WEBHOOK_SECRET não configurado — webhook aceito sem verificar assinatura (configure a variável de ambiente pra fechar essa brecha).');
    }

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
    invalidarCacheConfig();
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

// Trata erros de upload (tipo de arquivo errado, arquivo grande demais) com uma mensagem clara,
// em vez de estourar um erro genérico de servidor.
app.use((err, _req, res, next) => {
  if (err && (err.name === 'MulterError' || /imagens \(JPEG/.test(err.message || ''))) {
    return res.status(400).json({ status: 'error', error: err.message || 'Erro no arquivo enviado.' });
  }
  return next(err);
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
