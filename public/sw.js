// Service Worker — roda em segundo plano no navegador do cliente, mesmo com o site fechado.
// É ele que recebe a notificação push do servidor e mostra na barra de notificações do celular.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
