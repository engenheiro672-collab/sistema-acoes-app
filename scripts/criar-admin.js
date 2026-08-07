/**
 * Script pra criar (ou resetar a senha d)o seu usuário admin.
 * Rode UMA VEZ depois de configurar o banco e as variáveis de ambiente.
 *
 * Como usar:
 *   node scripts/criar-admin.js seu@email.com suaSenhaForte
 *
 * No Render: Dashboard do serviço → aba "Shell" → cole o comando acima.
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { createClient } from '@supabase/supabase-js';

const [, , email, senha] = process.argv;

if (!email || !senha) {
  console.error('Uso: node scripts/criar-admin.js seu@email.com suaSenhaForte');
  process.exit(1);
}

const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!process.env.SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY precisam estar configurados (.env ou variáveis de ambiente do Render).');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, SUPABASE_KEY);

async function main() {
  const password_hash = await bcrypt.hash(senha, 10);

  const { data: existente } = await supabase.from('admin_users').select('id').eq('email', email).maybeSingle();

  if (existente) {
    const { error } = await supabase.from('admin_users').update({ password_hash, status: 'active' }).eq('id', existente.id);
    if (error) { console.error('❌ Erro ao atualizar:', error.message); process.exit(1); }
    console.log(`✅ Senha atualizada para o admin existente: ${email}`);
  } else {
    const { error } = await supabase.from('admin_users').insert({ email, password_hash, name: 'Admin', status: 'active' });
    if (error) { console.error('❌ Erro ao criar:', error.message); process.exit(1); }
    console.log(`✅ Admin criado: ${email}`);
  }
  console.log('Agora é só entrar em /admin/login com esse email e senha.');
  process.exit(0);
}

main();
