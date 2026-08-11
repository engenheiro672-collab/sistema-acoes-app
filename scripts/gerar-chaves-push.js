// Roda isso UMA VEZ pra gerar as chaves VAPID do seu sistema de notificação push.
// Depois, coloca o resultado no .env (ou nas variáveis de ambiente do Render).
import webPush from 'web-push';

const chaves = webPush.generateVAPIDKeys();
console.log('Cole isso no seu .env (ou nas variáveis de ambiente do Render):\n');
console.log(`VAPID_PUBLIC_KEY=${chaves.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${chaves.privateKey}`);
