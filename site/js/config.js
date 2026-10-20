// Cole aqui a URL do App da Web do Google Apps Script (termina em /exec).
// Enquanto estiver vazia, o site roda em MODO DEMONSTRAÇÃO e NÃO registra reservas.
window.BLOCO22_CONFIG = {
  // Para pausar as reservas, escreva o aviso aqui (o site para de chamar o sistema).
  // Para reabrir, deixe vazio: PAUSED: 'Estamos preparando novas camisas para vocês! O Bloco do 22 já é um sucesso. Mais informações em breve.',
  PAUSED: 'Estamos preparando novas camisas para vocês! O Bloco do 22 já é um sucesso. Mais informações em breve.',
  // Reservas pelo Supabase (aguenta milhares de acessos; a planilha recebe a cada 1 minuto)
  SUPABASE_URL: 'https://mmvcveyfvysrzoxcvzxd.supabase.co',
  SUPABASE_KEY: 'sb_publishable_UXy2eIUyoG-BW8COyuhSmg_LGBvxc4S',
  API_URL: 'https://script.google.com/macros/s/AKfycbxRQUI5CnoErj9xp43ZQ-pifQH9m14wV8oHpvU0bL5TAnoXKZkC_OqmXxn1bknHm-Tl/exec',
};
