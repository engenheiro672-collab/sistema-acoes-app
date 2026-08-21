// Service Worker — roda em segundo plano no navegador do cliente, mesmo com o site fechado.
// É ele que recebe a notificação push do servidor e mostra na barra de notificações do celular.
// TAMBÉM guarda as bibliotecas (jQuery, ícones, fontes) e as páginas de sorteio no celular da
// pessoa — assim, na segunda visita, tudo isso carrega na hora, sem precisar buscar de novo.

const CACHE_ESTATICO = 'sistema-sorteios-estatico-v1';
const CACHE_PAGINAS = 'sistema-sorteios-paginas-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const HOSTS_SEGUROS_PRA_CACHE = ['code.jquery.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'];

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // ⚡⚡ A parte que faz a segunda visita parecer "instantânea": mostra a página guardada NA HORA
  // (se já tiver visitado antes), enquanto busca uma versão atualizada em segundo plano, pra
  // próxima vez já vir com a mais nova. Isso é seguro porque os DADOS DE VERDADE (preço, cotas
  // disponíveis, quantos títulos premiados já saíram) sempre são buscados frescos pela própria
  // página, na hora — só o "esqueleto" (HTML/CSS já prontos, sem os dados) que vem do cache.
  // Nunca aplica no checkout (ali tem que ser sempre 100% em tempo real, é dinheiro de verdade).
  const ehPaginaDeSorteio = event.request.mode === 'navigate' && /^\/sorteio\//.test(url.pathname);
  if (ehPaginaDeSorteio) {
    event.respondWith(
      caches.open(CACHE_PAGINAS).then(async (cache) => {
        const emCache = await cache.match(event.request);
        const buscaEAtualizaCache = fetch(event.request).then((resposta) => {
          if (resposta && resposta.ok) cache.put(event.request, resposta.clone());
          return resposta;
        }).catch(() => emCache);
        return emCache || buscaEAtualizaCache;
      })
    );
    return;
  }

  // ⚡ Guarda em cache só bibliotecas externas conhecidas (CDN) e o nosso próprio CSS — NUNCA
  // mexe em chamadas de API (/api/) ou imagens de sorteio (que podem mudar a qualquer momento
  // pelo admin). "Cache primeiro": se já tem guardado, usa na hora; senão, busca e guarda.
  const ehBibliotecaExterna = HOSTS_SEGUROS_PRA_CACHE.includes(url.hostname);
  const ehNossoCssEstatico = url.pathname.startsWith('/css/');
  if (!ehBibliotecaExterna && !ehNossoCssEstatico) return; // deixa passar normal, sem interceptar

  event.respondWith(
    caches.open(CACHE_ESTATICO).then(async (cache) => {
      const emCache = await cache.match(event.request);
      if (emCache) return emCache;
      try {
        const resposta = await fetch(event.request);
        if (resposta && resposta.ok) cache.put(event.request, resposta.clone());
        return resposta;
      } catch (e) {
        return emCache || Response.error();
      }
    })
  );
});

// Chegou uma notificação push do servidor — mostra ela
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let dados = {};
  try { dados = event.data.json(); } catch (e) { dados = { title: 'Notificação', body: event.data.text() }; }

  const opcoes = {
    body: dados.body || '',
    icon: dados.icon || '/favicon.ico',
    badge: dados.icon || '/favicon.ico',
    image: dados.image || undefined,
    data: { url: dados.url || '/', disparoId: dados.disparoId || null },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(self.registration.showNotification(dados.title || 'Notificação', opcoes));
});

// Cliente clicou na notificação — abre o link de destino e avisa o servidor pra contar o clique
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const disparoId = event.notification.data?.disparoId;

  event.waitUntil(
    (async () => {
      if (disparoId) {
        try { await fetch(`/api/public/push/registrar-clique/${disparoId}`, { method: 'POST' }); } catch (e) {}
      }
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});
