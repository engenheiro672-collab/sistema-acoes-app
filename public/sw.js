// Service Worker — roda em segundo plano no navegador do cliente, mesmo com o site fechado.
// É ele que recebe a notificação push do servidor e mostra na barra de notificações do celular.
// TAMBÉM guarda as bibliotecas externas (jQuery, ícones, fontes) e o nosso CSS no celular da
// pessoa — assim, na segunda visita, tudo isso carrega na hora, sem precisar buscar de novo.
//
// ⚡ IMPORTANTE: a página do sorteio em si (o HTML) NÃO é guardada em cache por aqui — só
// bibliotecas e CSS que nunca mudam. Isso é de propósito: guardar a página em cache e "atualizar
// por trás" tinha um efeito colateral sério — cada reabertura de aba, mesmo sem a pessoa clicar
// em nada de novo, disparava uma busca de verdade ao servidor, contando como um acesso novo, e
// inflava muito os números. Sem essa parte, os acessos voltam a bater com cliques reais.

const CACHE_ESTATICO = 'sistema-sorteios-estatico-v1';

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

  // ⚡ Guarda em cache só bibliotecas externas conhecidas (CDN) e o nosso próprio CSS — NUNCA
  // mexe em chamadas de API (/api/), imagens de sorteio, nem nas páginas em si (que podem mudar
  // a qualquer momento pelo admin, ou precisam ser sempre contadas certinho como acesso).
  // "Cache primeiro": se já tem guardado, usa na hora; senão, busca e guarda.
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
