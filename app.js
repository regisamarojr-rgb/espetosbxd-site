/* ===================================================
   BXD - Gerenciador de Espetos
   Logica do app (dados em localStorage)
   =================================================== */

const STORAGE_KEY = "bxd_data_v1";
// Guarda o id do usuário logado neste navegador/dispositivo (login simples por
// PIN, não é uma autenticação de servidor — só controla o que aparece na tela).
const LOGIN_STORAGE_KEY = "bxd_usuario_logado_v1";

/* ===================================================
   FIREBASE (sincronização em nuvem entre dispositivos)
   Substitua os valores abaixo pelas chaves do SEU projeto Firebase:
   Configurações do projeto > Geral > "Seus apps" > SDK setup and configuration.
   =================================================== */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCh9Lo4Kal2VgvGKzKzYcCx6-v6iYQv1iQ",
  authDomain: "espetosbxd-6a4d3.firebaseapp.com",
  projectId: "espetosbxd-6a4d3",
  storageBucket: "espetosbxd-6a4d3.firebasestorage.app",
  messagingSenderId: "445430834756",
  appId: "1:445430834756:web:77d42342f0367f77b2be11",
};

// Um único negócio (uma espetaria) = um único documento no Firestore.
// Todos os dispositivos (celular, computador, etc.) leem e escrevem nele.
const FIRESTORE_COLLECTION = "bxd";
const FIRESTORE_DOC = "dados";

// Pagamento via Pix no cardápio do cliente (cardapio.html).
// Código "copia e cola" (BR Code) da chave Pix cadastrada no PagSeguro.
const PIX_BRCODE =
  "00020126580014br.gov.bcb.pix0136af05da28-4252-4cb3-bd37-0fe394db257427600016BR.COM.PAGSEGURO01365AD1CA6C-CA69-4524-A028-71FB2B1573EC5204549953039865802BR5923MATHEUS MACIEL BALDIBIA6012Praia Grande62290525PAGS0000000002608041702686304C209";
// Link para o cliente enviar o comprovante de pagamento no WhatsApp.
const WHATSAPP_COMPROVANTE_LINK = "https://wa.me/message/IJNY7MZCL6WVH1";

// ---- Geração do BR Code (Pix "copia e cola") já com o valor do pedido ----
// O código cadastrado (PIX_BRCODE) é "valor livre" (não tem o campo 54).
// Essas funções reescrevem o payload EMV inserindo o valor exato do pedido
// e recalculando o CRC16, para o cliente não precisar digitar o valor.
function crc16ccitt(str) {
  let crc = 0xffff;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function parsePixTLV(payload) {
  const fields = [];
  let i = 0;
  while (i < payload.length) {
    const id = payload.substr(i, 2);
    const len = parseInt(payload.substr(i + 2, 2), 10);
    const value = payload.substr(i + 4, len);
    fields.push({ id, value });
    i += 4 + len;
  }
  return fields;
}

function buildPixTLV(fields) {
  return fields.map((f) => f.id + String(f.value.length).padStart(2, "0") + f.value).join("");
}

function gerarPixComValor(basePayload, valor) {
  let fields = parsePixTLV(basePayload).filter((f) => f.id !== "63" && f.id !== "54");
  fields.push({ id: "54", value: Number(valor).toFixed(2) });
  fields.sort((a, b) => a.id.localeCompare(b.id));
  const semCrc = buildPixTLV(fields) + "6304";
  return semCrc + crc16ccitt(semCrc);
}

let firebaseDb = null;
let firebaseReady = false;

function initFirebase() {
  try {
    if (typeof firebase === "undefined" || !FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey === "COLOQUE_AQUI") {
      console.warn("Firebase não configurado ainda — rodando só com localStorage neste navegador.");
      return;
    }
    firebase.initializeApp(FIREBASE_CONFIG);
    firebaseDb = firebase.firestore();
    firebaseReady = true;

    const docRef = firebaseDb.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);

    // Sempre que os dados mudarem na nuvem (em qualquer dispositivo), atualiza
    // este dispositivo também: localStorage + DATA em memória + tela atual.
    docRef.onSnapshot(
      (snap) => {
        if (!snap.exists) {
          // Primeira vez: ainda não existe nada na nuvem — sobe o que já
          // temos localmente (deste dispositivo) para começar a sincronização.
          docRef.set(DATA).catch((e) => console.error("Erro ao criar dados na nuvem.", e));
          return;
        }
        const remoteData = snap.data();
        if (!remoteData) return;
        DATA = Object.assign(defaultData(), remoteData);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
        } catch (e) {
          // segue mesmo se não conseguir gravar localStorage
        }
        rerenderPaginaAtual();
      },
      (e) => console.error("Erro ao sincronizar com a nuvem.", e)
    );
  } catch (e) {
    console.error("Erro ao iniciar Firebase.", e);
  }
}

// Re-renderiza a página atual com os dados mais recentes (usado tanto pela
// sincronização entre abas quanto pela sincronização em nuvem via Firebase).
function rerenderPaginaAtual() {
  if (document.getElementById("pedidos-list")) renderPedidos();
  if (document.getElementById("caixa-list")) renderCaixa();
  if (document.getElementById("estoque-list")) renderEstoque();
  if (document.getElementById("historico-list")) renderHistorico();
  if (document.getElementById("menu-list")) renderCardapio();
  if (document.getElementById("page-relatorios")) renderRelatorios();
  if (ACOMPANHAR_PEDIDO_ID) renderAcompanhamentoPedido();
}

// Fluxo de status do pedido:
// aberto -> (pronto) aguardando_motoboy OU aguardando_balcao, conforme o tipo de
// entrega -> entregue (finalizado, marcado como pago automaticamente).
const STATUS_LABEL = {
  aberto: "Em aberto",
  aguardando_motoboy: "Retirada motoboy",
  aguardando_balcao: "Retirada balcão",
  entregue: "Entregue / Concluído",
};

// Agrupamento dos status em 4 colunas na página de Pedidos
const STATUS_GROUPS = [
  { key: "aberto", label: "Pedidos em aberto", statuses: ["aberto"] },
  { key: "aguardando_motoboy", label: "Retirada motoboy", statuses: ["aguardando_motoboy"] },
  { key: "aguardando_balcao", label: "Retirada balcão", statuses: ["aguardando_balcao"] },
  { key: "finalizados", label: "Finalizados", statuses: ["entregue"] },
];

// Pedido do tipo "entrega" vai de moto (motoboy); demais tipos (retirada, balcão,
// mesa) são retirados/servidos no próprio local.
function isPedidoMotoboy(order) {
  return order.customer.tipoEntrega === "entrega";
}

// Próximo status no fluxo, considerando o tipo de entrega. Retorna null quando o
// pedido já está finalizado (entregue).
function getNextStatus(order) {
  if (order.status === "aberto") {
    return isPedidoMotoboy(order) ? "aguardando_motoboy" : "aguardando_balcao";
  }
  if (order.status === "aguardando_motoboy" || order.status === "aguardando_balcao") {
    return "entregue";
  }
  return null;
}

// Texto do botão de ação rápida (card compacto e modal), conforme o status atual.
function getAvancarLabel(order) {
  if (order.status === "aberto") return "Pedido pronto";
  if (order.status === "aguardando_motoboy" || order.status === "aguardando_balcao") return "Entregue";
  return null;
}

// A cada esse valor (R$) acumulado em pedidos, o cliente ganha uma cortesia/desconto
const COURTESY_THRESHOLD = 500;

// Programa de pontuação/fidelidade: 1 ponto para cada R$1,00 gasto (acumulado
// no histórico geral do cliente, independente do filtro de período).
const PONTOS_POR_REAL = 1;

// Programa de cashback: % do total geral gasto pelo cliente vira saldo
// disponível para resgate (descontado o que já foi resgatado).
const CASHBACK_PERCENT = 0.05;

// Cliente é considerado inativo quando passa esse número de dias sem novo pedido.
const INATIVO_DIAS = 45;

// Dias da semana usados na Escala de funcionários (chave curta → rótulo exibido).
const DIAS_SEMANA = [
  { key: "seg", label: "Seg" },
  { key: "ter", label: "Ter" },
  { key: "qua", label: "Qua" },
  { key: "qui", label: "Qui" },
  { key: "sex", label: "Sex" },
  { key: "sab", label: "Sáb" },
  { key: "dom", label: "Dom" },
];

function escalaVazia() {
  const e = {};
  DIAS_SEMANA.forEach((d) => (e[d.key] = false));
  return e;
}

// Permissões por papel de usuário: quais abas do painel cada papel pode ver.
// "dono" tem acesso total; "funcionario" só acessa a aba de Pedidos (operação
// do dia a dia), sem ver dados financeiros/estratégicos (Caixa, Estoque, Histórico).
const PAPEIS_PERMISSOES = {
  dono: { pedidos: true, caixa: true, estoque: true, entrega: true, colaboradores: true, historico: true, relatorios: true },
  funcionario: { pedidos: true, caixa: false, estoque: false, entrega: false, colaboradores: false, historico: false, relatorios: false },
};
const PAPEL_LABEL = { dono: "Dono", funcionario: "Funcionário" };

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function fmtMoney(v) {
  return "R$ " + (Number(v) || 0).toFixed(2).replace(".", ",");
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR") + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso) {
  // iso as yyyy-mm-dd
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const MESES_PT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

// Segunda-feira (yyyy-mm-dd) da semana à qual a data pertence
function weekStartISO(dateISO) {
  const d = new Date(dateISO + "T00:00:00");
  const dayNr = (d.getDay() + 6) % 7; // 0 = segunda
  d.setDate(d.getDate() - dayNr);
  return d.toISOString().slice(0, 10);
}

function weekEndISO(weekStartIso) {
  const d = new Date(weekStartIso + "T00:00:00");
  d.setDate(d.getDate() + 6);
  return d.toISOString().slice(0, 10);
}

function monthKey(dateISO) {
  return dateISO.slice(0, 7); // yyyy-mm
}

function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${MESES_PT[Number(m) - 1]}/${y}`;
}

function fmtNumero(n) {
  return String(n).padStart(3, "0");
}

// Número sequencial do pedido dentro do dia (zera a cada dia, ex: 001, 002...).
// Pedidos antigos que não tenham o campo "numero" salvo recebem um número
// calculado pela ordem de criação dentro do mesmo dia, como fallback.
function getOrderNumero(o) {
  if (o.numero) return o.numero;
  const day = o.createdAt.slice(0, 10);
  const sameDay = DATA.orders
    .filter((x) => x.createdAt.slice(0, 10) === day)
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return sameDay.findIndex((x) => x.id === o.id) + 1;
}

/* ---------- Dados iniciais (cardapio real BXD) ---------- */

function defaultData() {
  return {
    menu: [
      { id: "m1", categoria: "Espetos Premium", nome: "Coração", preco: 13 },
      { id: "m2", categoria: "Espetos Premium", nome: "Carne", preco: 13 },
      { id: "m3", categoria: "Espetos Premium", nome: "Carne com gordura", preco: 12 },
      { id: "m4", categoria: "Espetos Premium", nome: "Kafta", preco: 11 },
      { id: "m5", categoria: "Espetos Premium", nome: "Linguiça", preco: 10 },
      { id: "m6", categoria: "Espetos Premium", nome: "Frango", preco: 10 },
      { id: "m7", categoria: "Medalhões", nome: "Medalhão Frango", preco: 20 },
      { id: "m8", categoria: "Medalhões", nome: "Medalhão Carne", preco: 20 },
      { id: "m9", categoria: "Jantinha", nome: "Janta premium 1 espeto", preco: 20, desc: "Arroz, farofa, vinagrete" },
      { id: "m10", categoria: "Acompanhamentos", nome: "Queijo Quata", preco: 13 },
      { id: "m11", categoria: "Acompanhamentos", nome: "Pão de Alho", preco: 10 },
      { id: "m12", categoria: "Acompanhamentos", nome: "Pão Francês", preco: 6 },
    ],
    orders: [],
    cash: [],
    // Histórico de pedidos cancelados (motivo + snapshot do pedido no momento do cancelamento).
    cancelamentos: [],
    // Histórico de perdas/desperdício de estoque (quantidade + motivo), separado
    // da baixa normal por venda.
    perdas: [],
    // Histórico de compras de estoque (fornecedor/mercado): cada reabastecimento
    // registrado soma a quantidade comprada ao estoque e fica salvo aqui.
    compras: [],
    // Lista de clientes marcados como VIP manualmente pelo dono (chave = telefone
    // do cliente, ou o nome quando não há telefone cadastrado).
    clientesVip: [],
    // Histórico de resgates de cashback por cliente (chave = telefone/nome).
    // O saldo disponível é calculado como (% do total gasto) − (soma dos resgates).
    cashbackResgates: [],
    // Datas de aniversário cadastradas manualmente por cliente (chave = telefone/nome
    // → string "MM-DD"). Cadastro opcional, feito na página Histórico de Clientes.
    clientesAniversarios: {},
    // Bairros de entrega cadastrados pelo dono, cada um com sua taxa fixa (R$).
    // Usado no cardápio para preencher a taxa de entrega automaticamente ao
    // escolher o bairro; se a lista estiver vazia, o cliente informa manualmente.
    bairros: [],
    // Entregadores (motoboys) cadastrados pelo dono. "ativo": false = deixou de
    // trabalhar, mas continua existindo para preservar o histórico de pedidos
    // já atribuídos a ele.
    entregadores: [],
    // Funcionários cadastrados pelo dono (cozinha, atendimento etc.). "ativo":
    // false = deixou de trabalhar, mas continua existindo para preservar
    // qualquer histórico (comissão, escala, ponto) já ligado a ele.
    funcionarios: [],
    // Registro de ponto (entrada/saída) dos funcionários: cada batida guarda
    // quem bateu, o tipo (entrada/saida) e o horário exato.
    registrosPonto: [],
    // Usuários que podem acessar o painel do dono (login por PIN neste
    // navegador/dispositivo). "papel" define quais abas cada um enxerga —
    // ver PAPEIS_PERMISSOES. Não é autenticação de servidor, é só uma trava
    // simples de tela para uso local.
    usuarios: [],
    // "custo" é o custo unitário (R$) de cada item — usado para calcular a
    // previsão de faturamento (lucro) no Fluxo de Caixa. Ainda não preenchidos
    // com valores reais: edite direto na tabela da página Estoque.
    // Custos abaixo = tabela do fornecedor RC Premier Espetinhos, linha Espetaria
    // (pacote 1kg), conforme informado pelo dono em jul/2026. Itens que a RC Premier
    // não vende (queijo, pães, arroz, farofa, vinagrete) ficam com custo: 0 até serem
    // preenchidos manualmente na página Estoque.
    stock: [
      { id: "s1", nome: "Espeto de Coração", unidade: "un", quantidade: 30, minimo: 10, custo: 4.9 },
      { id: "s2", nome: "Espeto de Carne (Fraldinha)", unidade: "un", quantidade: 30, minimo: 10, custo: 4.79 },
      { id: "s3", nome: "Espeto de Carne com gordura (Alcatra)", unidade: "un", quantidade: 30, minimo: 10, custo: 4.69 },
      { id: "s4", nome: "Espeto de Kafta", unidade: "un", quantidade: 30, minimo: 10, custo: 4.0 },
      { id: "s5", nome: "Espeto de Linguiça", unidade: "un", quantidade: 30, minimo: 10, custo: 3.3 },
      { id: "s6", nome: "Espeto de Frango", unidade: "un", quantidade: 30, minimo: 10, custo: 3.6 },
      { id: "s7", nome: "Queijo Quata", unidade: "un", quantidade: 15, minimo: 5, custo: 0 },
      { id: "s8", nome: "Pão de Alho", unidade: "un", quantidade: 20, minimo: 5, custo: 0 },
      { id: "s9", nome: "Pão Francês", unidade: "un", quantidade: 20, minimo: 5, custo: 0 },
      { id: "s10", nome: "Arroz", unidade: "kg", quantidade: 5, minimo: 1, custo: 0 },
      { id: "s11", nome: "Farofa", unidade: "kg", quantidade: 3, minimo: 1, custo: 0 },
      { id: "s12", nome: "Vinagrete", unidade: "kg", quantidade: 2, minimo: 0.5, custo: 0 },
      { id: "s13", nome: "Medalhão Frango", unidade: "un", quantidade: 15, minimo: 5, custo: 7.78 },
      { id: "s14", nome: "Medalhão Carne", unidade: "un", quantidade: 15, minimo: 5, custo: 7.98 },
    ],
  };
}

// Relação entre item do cardápio e o que ele consome do estoque por unidade vendida.
// Ex: 1x "Coração" desconta 1 unidade do estoque "Espeto de Coração".
const MENU_RECIPE = {
  m1: [{ stockId: "s1", qtd: 1 }],
  m2: [{ stockId: "s2", qtd: 1 }],
  m3: [{ stockId: "s3", qtd: 1 }],
  m4: [{ stockId: "s4", qtd: 1 }],
  m5: [{ stockId: "s5", qtd: 1 }],
  m6: [{ stockId: "s6", qtd: 1 }],
  m7: [{ stockId: "s13", qtd: 1 }],
  m8: [{ stockId: "s14", qtd: 1 }],
  m9: [
    { stockId: "s10", qtd: 0.1 },
    { stockId: "s11", qtd: 0.1 },
    { stockId: "s12", qtd: 0.05 },
  ],
  m10: [{ stockId: "s7", qtd: 1 }],
  m11: [{ stockId: "s8", qtd: 1 }],
  m12: [{ stockId: "s9", qtd: 1 }],
};

// Custos reais informados pelo dono (tabela RC Premier Espetinhos, linha
// Espetaria/pacote 1kg, jul/2026). Aplicado uma única vez por navegador para quem
// já tinha dados salvos com custo: 0, sem sobrescrever edições manuais futuras.
const CUSTOS_CONHECIDOS_RC_PREMIER = {
  s1: 4.9, // Espeto de Coração
  s2: 4.79, // Espeto de Carne (Fraldinha)
  s3: 4.69, // Espeto de Carne com gordura (Alcatra)
  s4: 4.0, // Espeto de Kafta
  s5: 3.3, // Espeto de Linguiça
  s6: 3.6, // Espeto de Frango
  s13: 7.78, // Medalhão Frango (pct 5)
  s14: 7.98, // Medalhão Carne (pct 5)
};

// Migração: renomeia os itens de estoque para deixar claro qual corte de carne
// é cada um (Fraldinha / Alcatra), sem sobrescrever nomes já editados manualmente.
const NOMES_CORTES_CARNE = {
  s2: { de: "Espeto de Carne", para: "Espeto de Carne (Fraldinha)" },
  s3: { de: "Espeto de Carne com gordura", para: "Espeto de Carne com gordura (Alcatra)" },
};

var DATA = loadData();
ensureDefaultStockItems();
ensureStockCustoField();
ensureCustosConhecidos();
ensureNomesCortesCarne();
ensureNovoFluxoStatusPedidos();
ensureCancelamentosField();
ensurePerdasField();
ensureComprasField();
ensureClientesVipField();
ensureCashbackResgatesField();
ensureClientesAniversariosField();
ensureBairrosField();
ensureEntregadoresField();
ensureFuncionariosField();
ensureEscalaFuncionarios();
ensureRegistrosPontoField();
ensureUsuariosField();
ensureColaboradorPadrao();
initFirebase();

// Migração: pedidos salvos com o fluxo de status antigo (novo/preparo/saiu)
// passam para o novo fluxo (aberto/aguardando_motoboy/aguardando_balcao/entregue).
function ensureNovoFluxoStatusPedidos() {
  let changed = false;
  DATA.orders.forEach((o) => {
    if (o.status === "novo" || o.status === "preparo") {
      o.status = "aberto";
      changed = true;
    } else if (o.status === "saiu") {
      o.status = isPedidoMotoboy(o) ? "aguardando_motoboy" : "aguardando_balcao";
      changed = true;
    }
  });
  if (changed) saveData();
}

// Garante que itens novos do estoque padrão (ex: adicionados em uma atualização)
// apareçam mesmo para quem já tinha dados salvos, sem apagar o que o dono já editou.
function ensureDefaultStockItems() {
  const defaults = defaultData().stock;
  let changed = false;
  defaults.forEach((def) => {
    if (!DATA.stock.some((s) => s.id === def.id)) {
      DATA.stock.push({ ...def });
      changed = true;
    }
  });
  if (changed) saveData();
}

// Migração: quem já tinha dados salvos antes do campo "custo" existir
// recebe custo = 0 em cada item, sem apagar o que já foi preenchido.
function ensureStockCustoField() {
  let changed = false;
  DATA.stock.forEach((s) => {
    if (typeof s.custo !== "number" || isNaN(s.custo)) {
      s.custo = 0;
      changed = true;
    }
  });
  if (changed) saveData();
}

function ensureCustosConhecidos() {
  if (DATA._custosConhecidosAplicados) return;
  DATA.stock.forEach((s) => {
    if (CUSTOS_CONHECIDOS_RC_PREMIER[s.id] !== undefined && (!s.custo || s.custo === 0)) {
      s.custo = CUSTOS_CONHECIDOS_RC_PREMIER[s.id];
    }
  });
  DATA._custosConhecidosAplicados = true;
  saveData();
}

function ensureNomesCortesCarne() {
  if (DATA._nomesCortesCarneAplicados) return;
  DATA.stock.forEach((s) => {
    const info = NOMES_CORTES_CARNE[s.id];
    if (info && s.nome === info.de) {
      s.nome = info.para;
    }
  });
  DATA._nomesCortesCarneAplicados = true;
  saveData();
}

// Migração: quem já tinha dados salvos antes do histórico de cancelamentos existir
// recebe um array vazio, sem apagar nada que já exista.
function ensureCancelamentosField() {
  if (Array.isArray(DATA.cancelamentos)) return;
  DATA.cancelamentos = [];
  saveData();
}

// Migração: quem já tinha dados salvos antes do histórico de perdas/desperdício
// existir recebe um array vazio, sem apagar nada que já exista.
function ensurePerdasField() {
  if (Array.isArray(DATA.perdas)) return;
  DATA.perdas = [];
  saveData();
}

// Migração: quem já tinha dados salvos antes do histórico de compras existir
// recebe um array vazio, sem apagar nada que já exista.
function ensureComprasField() {
  if (Array.isArray(DATA.compras)) return;
  DATA.compras = [];
  saveData();
}

// Migração: quem já tinha dados salvos antes da marcação de Cliente VIP existir
// recebe um array vazio, sem apagar nada que já exista.
function ensureClientesVipField() {
  if (Array.isArray(DATA.clientesVip)) return;
  DATA.clientesVip = [];
  saveData();
}

// Migração: quem já tinha dados salvos antes do cashback existir recebe um
// array vazio, sem apagar nada que já exista.
function ensureCashbackResgatesField() {
  if (Array.isArray(DATA.cashbackResgates)) return;
  DATA.cashbackResgates = [];
  saveData();
}

// Migração: quem já tinha dados salvos antes do cadastro de aniversários
// existir recebe um objeto vazio, sem apagar nada que já exista.
function ensureClientesAniversariosField() {
  if (DATA.clientesAniversarios && typeof DATA.clientesAniversarios === "object" && !Array.isArray(DATA.clientesAniversarios)) return;
  DATA.clientesAniversarios = {};
  saveData();
}

// Migração: quem já tinha dados salvos antes do cadastro de bairros de
// entrega existir recebe uma lista vazia, sem apagar nada que já exista.
function ensureBairrosField() {
  if (Array.isArray(DATA.bairros)) return;
  DATA.bairros = [];
  saveData();
}

function adicionarBairro(nome, taxa) {
  refreshDataFromStorage();
  DATA.bairros.push({ id: uid("brr"), nome: nome.trim(), taxa: Math.round((Number(taxa) || 0) * 100) / 100 });
  saveData();
  renderBairros();
  toast("Bairro adicionado.");
}

function removerBairro(id) {
  refreshDataFromStorage();
  DATA.bairros = DATA.bairros.filter((b) => b.id !== id);
  saveData();
  renderBairros();
  toast("Bairro removido.");
}

// Lista de bairros cadastrados na página Estoque (gerenciamento do dono).
function renderBairros() {
  const container = document.getElementById("bairros-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.bairros.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum bairro cadastrado. Sem bairros cadastrados, o cliente informa a taxa de entrega manualmente no cardápio.</div>`;
    return;
  }

  DATA.bairros.forEach((b) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${b.nome}</span>
        <span class="valor">${fmtMoney(b.taxa)}</span>
      </div>
      <div class="meta"><button class="btn small secondary btn-remover-bairro">Remover</button></div>
    `;
    div.querySelector(".btn-remover-bairro").addEventListener("click", () => removerBairro(b.id));
    container.appendChild(div);
  });
}

// Preenche o <select> de bairros no cardápio (cardapio.html). Se não houver
// bairros cadastrados, mantém o campo de taxa manual (comportamento antigo).
function popularSelectBairros() {
  const select = document.getElementById("f-bairro");
  const campoManual = document.getElementById("campo-taxa-manual");
  if (!select) return;
  const campoSelect = document.getElementById("campo-bairro");

  if (!DATA.bairros || DATA.bairros.length === 0) {
    if (campoSelect) campoSelect.style.display = "none";
    if (campoManual) campoManual.style.display = "block";
    return;
  }

  if (campoSelect) campoSelect.style.display = "block";
  if (campoManual) campoManual.style.display = "none";

  select.innerHTML =
    `<option value="">Selecione o bairro...</option>` +
    DATA.bairros.map((b) => `<option value="${b.id}">${b.nome} — ${fmtMoney(b.taxa)}</option>`).join("");

  select.addEventListener("change", () => {
    const bairro = DATA.bairros.find((b) => b.id === select.value);
    const taxaEl = document.getElementById("f-taxa-entrega");
    if (taxaEl) taxaEl.value = bairro ? bairro.taxa : 0;
    renderCart();
  });
}

// Migração: quem já tinha dados salvos antes do cadastro de entregadores
// existir recebe uma lista vazia, sem apagar nada que já exista.
function ensureEntregadoresField() {
  if (Array.isArray(DATA.entregadores)) return;
  DATA.entregadores = [];
  saveData();
}

function adicionarEntregador(nome, telefone) {
  refreshDataFromStorage();
  DATA.entregadores.push({ id: uid("ent"), nome: nome.trim(), telefone: (telefone || "").trim(), ativo: true });
  saveData();
  renderEntregadores();
  toast("Entregador adicionado.");
}

function toggleEntregadorAtivo(id) {
  refreshDataFromStorage();
  const e = DATA.entregadores.find((x) => x.id === id);
  if (!e) return;
  e.ativo = !e.ativo;
  saveData();
  renderEntregadores();
}

function removerEntregador(id) {
  refreshDataFromStorage();
  DATA.entregadores = DATA.entregadores.filter((e) => e.id !== id);
  saveData();
  renderEntregadores();
  toast("Entregador removido.");
}

// Lista de entregadores cadastrados na página Estoque (gerenciamento do dono).
function renderEntregadores() {
  const container = document.getElementById("entregadores-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.entregadores.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum entregador cadastrado.</div>`;
    return;
  }

  DATA.entregadores.forEach((e) => {
    const stats = calcularTempoMedioEntrega(e.id);
    const qtdEntregas = stats ? stats.quantidade : 0;
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${e.nome}</span>
        <span class="tag ${e.ativo ? "pago" : "inativo"}">${e.ativo ? "Ativo" : "Inativo"}</span>
      </div>
      ${e.telefone ? `<div class="meta">${e.telefone}</div>` : ""}
      <div class="meta">${qtdEntregas} entrega${qtdEntregas === 1 ? "" : "s"} concluída${qtdEntregas === 1 ? "" : "s"}</div>
      <div class="meta">
        <button class="btn small secondary btn-toggle-entregador">${e.ativo ? "Desativar" : "Ativar"}</button>
        <button class="btn small secondary btn-remover-entregador">Remover</button>
      </div>
    `;
    div.querySelector(".btn-toggle-entregador").addEventListener("click", () => toggleEntregadorAtivo(e.id));
    div.querySelector(".btn-remover-entregador").addEventListener("click", () => removerEntregador(e.id));
    container.appendChild(div);
  });
}

// Migração: quem já tinha dados salvos antes do cadastro de funcionários
// existir recebe uma lista vazia, sem apagar nada que já exista.
function ensureFuncionariosField() {
  if (Array.isArray(DATA.funcionarios)) return;
  DATA.funcionarios = [];
  saveData();
}

function ensureRegistrosPontoField() {
  if (Array.isArray(DATA.registrosPonto)) return;
  DATA.registrosPonto = [];
  saveData();
}

// Migração: quem ainda não tem nenhum usuário cadastrado ganha um usuário
// "Dono" padrão (PIN 0000) para conseguir entrar no painel pela primeira vez.
// O dono pode (e deve) trocar o PIN ou cadastrar outros usuários depois, na
// aba Estoque > Usuários do sistema.
function ensureUsuariosField() {
  // Obs: defaultData() já inclui usuarios: [] (array vazio), então checar só
  // Array.isArray nunca detectaria "sem usuários" — precisa checar o tamanho
  // também, senão o Dono padrão nunca é criado e ninguém consegue logar.
  if (Array.isArray(DATA.usuarios) && DATA.usuarios.length > 0) return;
  DATA.usuarios = [{ id: uid("usr"), nome: "Dono", papel: "dono", pin: "0000", ativo: true }];
  saveData();
}

// Migração: quem ainda não tem nenhum usuário com papel "funcionario" ganha um
// login padrão de Colaborador (PIN 1234), já restrito só à aba Pedidos. O dono
// pode renomear, trocar o PIN ou cadastrar outros colaboradores depois, em
// Estoque > Usuários do sistema.
function ensureColaboradorPadrao() {
  if (!Array.isArray(DATA.usuarios)) return;
  if (DATA.usuarios.some((u) => u.papel === "funcionario")) return;
  DATA.usuarios.push({ id: uid("usr"), nome: "Colaborador", papel: "funcionario", pin: "1234", ativo: true });
  saveData();
}

// Migração: quem já tinha funcionários cadastrados antes da escala existir
// recebe uma escala vazia (nenhum dia marcado), sem apagar mais nada.
function ensureEscalaFuncionarios() {
  let changed = false;
  DATA.funcionarios.forEach((f) => {
    if (!f.escala || typeof f.escala !== "object") {
      f.escala = escalaVazia();
      changed = true;
    }
    if (typeof f.escalaHorario !== "string") {
      f.escalaHorario = "";
      changed = true;
    }
  });
  if (changed) saveData();
}

// Gera um PIN numérico de 4 dígitos para o login automático do funcionário,
// evitando repetir um PIN já em uso por outro usuário ativo.
function gerarPinUsuario() {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (DATA.usuarios.some((u) => u.ativo && u.pin === pin));
  return pin;
}

function adicionarFuncionario(nome, cargo, telefone) {
  refreshDataFromStorage();
  const novoFuncionario = {
    id: uid("fnc"),
    nome: nome.trim(),
    cargo: (cargo || "").trim(),
    telefone: (telefone || "").trim(),
    escala: escalaVazia(),
    escalaHorario: "",
    ativo: true,
  };
  DATA.funcionarios.push(novoFuncionario);

  // Já cria o login (Usuário do sistema) vinculado a esse funcionário, com
  // Papel = Funcionário e um PIN gerado automaticamente — assim o ponto já
  // funciona sem precisar de um passo manual separado.
  const pin = gerarPinUsuario();
  DATA.usuarios.push({
    id: uid("usr"),
    nome: novoFuncionario.nome,
    papel: "funcionario",
    pin,
    ativo: true,
    funcionarioId: novoFuncionario.id,
  });

  saveData();
  renderFuncionarios();
  renderEscala();
  renderUsuarios();
  toast(`Funcionário adicionado. Login criado — PIN: ${pin}`);
}

function toggleFuncionarioAtivo(id) {
  refreshDataFromStorage();
  const f = DATA.funcionarios.find((x) => x.id === id);
  if (!f) return;
  f.ativo = !f.ativo;
  // Acompanha o login vinculado: desativa/reativa junto com o funcionário.
  DATA.usuarios.forEach((u) => {
    if (u.funcionarioId === id) u.ativo = f.ativo;
  });
  saveData();
  renderFuncionarios();
  renderEscala();
  renderRegistroPonto();
  renderUsuarios();
}

function removerFuncionario(id) {
  refreshDataFromStorage();
  DATA.funcionarios = DATA.funcionarios.filter((f) => f.id !== id);
  // Remove junto o login vinculado a esse funcionário.
  DATA.usuarios = DATA.usuarios.filter((u) => u.funcionarioId !== id);
  saveData();
  renderFuncionarios();
  renderEscala();
  renderRegistroPonto();
  renderUsuarios();
  toast("Funcionário removido.");
}

// Lista de funcionários cadastrados na página Estoque (gerenciamento do dono).
function renderFuncionarios() {
  const container = document.getElementById("funcionarios-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.funcionarios.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum funcionário cadastrado.</div>`;
    return;
  }

  DATA.funcionarios.forEach((f) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${f.nome}</span>
        <span class="tag ${f.ativo ? "pago" : "inativo"}">${f.ativo ? "Ativo" : "Inativo"}</span>
      </div>
      ${f.cargo ? `<div class="meta">${f.cargo}</div>` : ""}
      ${f.telefone ? `<div class="meta">${f.telefone}</div>` : ""}
      <div class="meta">
        <button class="btn small secondary btn-toggle-funcionario">${f.ativo ? "Desativar" : "Ativar"}</button>
        <button class="btn small secondary btn-remover-funcionario">Remover</button>
      </div>
    `;
    div.querySelector(".btn-toggle-funcionario").addEventListener("click", () => toggleFuncionarioAtivo(f.id));
    div.querySelector(".btn-remover-funcionario").addEventListener("click", () => removerFuncionario(f.id));
    container.appendChild(div);
  });
}

// Lista de escala semanal por funcionário ativo, na página Estoque.
// As linhas ficam sempre visíveis (não colapsáveis) para não perder o estado
// dos checkboxes/horário ao clicar em "Salvar escala" e reconstruir a lista.
function renderEscala() {
  const container = document.getElementById("escala-list");
  if (!container) return;
  container.innerHTML = "";

  const funcionarios = DATA.funcionarios.filter((f) => f.ativo);
  if (funcionarios.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum funcionário ativo cadastrado.</div>`;
    return;
  }

  funcionarios.forEach((f) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${f.nome}</span>
      </div>
      <div class="meta" style="display:flex; flex-wrap:wrap; gap:10px;">
        ${DIAS_SEMANA.map(
          (d) => `
          <label style="display:flex; align-items:center; gap:4px;">
            <input type="checkbox" class="chk-dia" data-dia="${d.key}" ${f.escala && f.escala[d.key] ? "checked" : ""} />
            ${d.label}
          </label>
        `
        ).join("")}
      </div>
      <label>Horário</label>
      <input type="text" class="inp-horario" placeholder="Ex: 18h às 23h" value="${f.escalaHorario || ""}" />
      <div class="meta">
        <button class="btn small secondary btn-salvar-escala">Salvar escala</button>
      </div>
    `;
    div.querySelector(".btn-salvar-escala").addEventListener("click", () => {
      const escala = {};
      div.querySelectorAll(".chk-dia").forEach((chk) => {
        escala[chk.dataset.dia] = chk.checked;
      });
      const horario = div.querySelector(".inp-horario").value;
      salvarEscalaFuncionario(f.id, escala, horario);
    });
    container.appendChild(div);
  });
}

// Salva a escala semanal e o horário de um funcionário. Não chama renderEscala()
// depois, para não perder o estado recém-marcado dos checkboxes/input na tela.
function salvarEscalaFuncionario(id, escala, horario) {
  refreshDataFromStorage();
  const f = DATA.funcionarios.find((x) => x.id === id);
  if (!f) return;
  f.escala = escala;
  f.escalaHorario = horario;
  saveData();
  toast("Escala salva.");
}

// Confere se o funcionário já teve uma "entrada" registrada hoje — usada para
// só bater a entrada uma vez por dia (no primeiro login), mesmo que ele faça
// login de novo mais tarde no mesmo dia.
function temEntradaHoje(funcionarioId) {
  const hoje = new Date().toDateString();
  return DATA.registrosPonto.some(
    (r) => r.funcionarioId === funcionarioId && r.tipo === "entrada" && new Date(r.horario).toDateString() === hoje
  );
}

// Registra uma batida de ponto (entrada ou saída) para um funcionário.
function baterPonto(funcionarioId, tipo) {
  refreshDataFromStorage();
  const f = DATA.funcionarios.find((x) => x.id === funcionarioId);
  if (!f) return;
  DATA.registrosPonto.push({
    id: uid("pto"),
    funcionarioId: f.id,
    funcionarioNome: f.nome,
    tipo, // "entrada" ou "saida"
    horario: new Date().toISOString(),
  });
  saveData();
  renderRegistroPonto();
  toast(tipo === "entrada" ? "Entrada registrada." : "Saída registrada.");
}

// Lista as últimas batidas de ponto registradas, mais recentes primeiro.
function renderRegistroPonto() {
  const container = document.getElementById("ponto-list");
  if (!container) return;
  container.innerHTML = "";

  const registros = [...DATA.registrosPonto].sort((a, b) => new Date(b.horario) - new Date(a.horario)).slice(0, 30);
  if (registros.length === 0) {
    container.innerHTML = `<div class="empty">Nenhuma batida de ponto registrada ainda.</div>`;
    return;
  }

  registros.forEach((r) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${r.funcionarioNome}</span>
        <span class="tag ${r.tipo === "entrada" ? "pago" : "inativo"}">${r.tipo === "entrada" ? "Entrada" : "Saída"}</span>
      </div>
      <div class="meta">${fmtDateTime(r.horario)}</div>
    `;
    container.appendChild(div);
  });
}

function adicionarUsuario(nome, papel, pin, funcionarioId) {
  refreshDataFromStorage();
  DATA.usuarios.push({
    id: uid("usr"),
    nome: nome.trim(),
    papel,
    pin: (pin || "").trim(),
    ativo: true,
    funcionarioId: funcionarioId || "",
  });
  saveData();
  renderUsuarios();
  toast("Usuário adicionado.");
}

// Preenche o select de vínculo com funcionário no formulário de "Usuários do sistema",
// usado para bater o ponto automaticamente no login/logout desse usuário.
function popularSelectUsuarioFuncionario() {
  const select = document.getElementById("usr-funcionario");
  if (!select) return;
  const atual = select.value;
  select.innerHTML =
    `<option value="">Nenhum</option>` +
    DATA.funcionarios
      .filter((f) => f.ativo)
      .map((f) => `<option value="${f.id}">${f.nome}</option>`)
      .join("");
  if (DATA.funcionarios.some((f) => f.id === atual)) select.value = atual;
}

function toggleUsuarioAtivo(id) {
  refreshDataFromStorage();
  const u = DATA.usuarios.find((x) => x.id === id);
  if (!u) return;
  if (u.ativo && u.papel === "dono" && contarDonosAtivos() <= 1) {
    toast("Não é possível desativar o último usuário Dono.");
    return;
  }
  u.ativo = !u.ativo;
  saveData();
  renderUsuarios();
}

function removerUsuario(id) {
  refreshDataFromStorage();
  const u = DATA.usuarios.find((x) => x.id === id);
  if (u && u.papel === "dono" && contarDonosAtivos() <= 1) {
    toast("Não é possível remover o último usuário Dono.");
    return;
  }
  DATA.usuarios = DATA.usuarios.filter((x) => x.id !== id);
  saveData();
  renderUsuarios();
  toast("Usuário removido.");
}

// Lista de usuários do painel na página Estoque (gerenciamento do dono).
function renderUsuarios() {
  popularSelectUsuarioFuncionario();

  const container = document.getElementById("usuarios-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.usuarios.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum usuário cadastrado.</div>`;
    return;
  }

  DATA.usuarios.forEach((u) => {
    const funcionarioVinculado = u.funcionarioId ? DATA.funcionarios.find((f) => f.id === u.funcionarioId) : null;
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${u.nome}</span>
        <span class="tag ${u.ativo ? "pago" : "inativo"}">${u.ativo ? "Ativo" : "Inativo"}</span>
      </div>
      <div class="meta">${PAPEL_LABEL[u.papel] || u.papel} · PIN: ${u.pin}</div>
      ${funcionarioVinculado ? `<div class="meta">Ponto vinculado: ${funcionarioVinculado.nome}</div>` : ""}
      <div class="meta">
        <button class="btn small secondary btn-toggle-usuario">${u.ativo ? "Desativar" : "Ativar"}</button>
        <button class="btn small secondary btn-remover-usuario">Remover</button>
      </div>
    `;
    div.querySelector(".btn-toggle-usuario").addEventListener("click", () => toggleUsuarioAtivo(u.id));
    div.querySelector(".btn-remover-usuario").addEventListener("click", () => removerUsuario(u.id));
    container.appendChild(div);
  });
}

// Atribui (ou remove, se entregadorId for vazio) um entregador a um pedido de entrega.
function atribuirEntregador(orderId, entregadorId) {
  refreshDataFromStorage();
  const order = DATA.orders.find((o) => o.id === orderId);
  if (!order) return;
  const entregador = entregadorId ? DATA.entregadores.find((e) => e.id === entregadorId) : null;
  order.entregadorId = entregador ? entregador.id : "";
  order.entregadorNome = entregador ? entregador.nome : "";
  saveData();
  renderPedidos();

  const overlay = document.getElementById("pedido-modal-overlay");
  if (overlay && overlay.dataset.orderId === orderId) {
    openPedidoModal(orderId);
  }
}

// Atribui (ou remove, se funcionarioId for vazio) o funcionário responsável
// pela venda, usado no controle de caixa por operador.
function atribuirFuncionario(orderId, funcionarioId) {
  refreshDataFromStorage();
  const order = DATA.orders.find((o) => o.id === orderId);
  if (!order) return;
  const funcionario = funcionarioId ? DATA.funcionarios.find((f) => f.id === funcionarioId) : null;
  order.funcionarioId = funcionario ? funcionario.id : "";
  order.funcionarioNome = funcionario ? funcionario.nome : "";
  saveData();
  renderPedidos();

  const overlay = document.getElementById("pedido-modal-overlay");
  if (overlay && overlay.dataset.orderId === orderId) {
    openPedidoModal(orderId);
  }
}

// Formata uma duração em minutos como "Xmin" ou "Xh Ymin" quando passa de 1h.
function fmtDuracaoMin(min) {
  const arredondado = Math.round(min);
  if (arredondado < 60) return `${arredondado} min`;
  const h = Math.floor(arredondado / 60);
  const m = arredondado % 60;
  return `${h}h${m > 0 ? " " + m + "min" : ""}`;
}

// Tempo médio de entrega (em minutos) considerando só pedidos do tipo "entrega"
// (motoboy) que já foram marcados como entregues. Opcionalmente filtra por
// entregador específico.
function calcularTempoMedioEntrega(entregadorId) {
  const entregas = DATA.orders.filter(
    (o) => isPedidoMotoboy(o) && o.entregueAt && (!entregadorId || o.entregadorId === entregadorId)
  );
  if (entregas.length === 0) return null;
  const totalMin = entregas.reduce((acc, o) => acc + (new Date(o.entregueAt) - new Date(o.createdAt)) / 60000, 0);
  return { minutos: totalMin / entregas.length, quantidade: entregas.length };
}

// Painel com o tempo médio de entrega geral e por entregador (página Estoque).
function renderTempoEntrega() {
  const container = document.getElementById("tempo-entrega-info");
  if (!container) return;

  const geral = calcularTempoMedioEntrega();
  if (!geral) {
    container.innerHTML = `<div class="empty">Nenhuma entrega concluída até agora.</div>`;
    return;
  }

  const porEntregador = DATA.entregadores
    .map((e) => ({ nome: e.nome, stats: calcularTempoMedioEntrega(e.id) }))
    .filter((e) => e.stats);

  container.innerHTML = `
    <div class="ranking-list">
      <div class="ranking-row">
        <div class="nome"><strong>Geral</strong></div>
        <div class="valor">${fmtDuracaoMin(geral.minutos)} <span class="sub">(${geral.quantidade} entrega${geral.quantidade > 1 ? "s" : ""})</span></div>
      </div>
      ${porEntregador
        .map(
          (e) => `
        <div class="ranking-row">
          <div class="nome">${e.nome}</div>
          <div class="valor">${fmtDuracaoMin(e.stats.minutos)} <span class="sub">(${e.stats.quantidade} entrega${e.stats.quantidade > 1 ? "s" : ""})</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Lista de todas as entregas já concluídas (pedidos tipo "entrega" já marcados
// como "entregue"), mais recentes primeiro — acessada via modal na página de
// Pedidos, mesmo padrão do modal de Cancelamentos.
function renderEntregas() {
  const container = document.getElementById("entregas-list");
  if (!container) return;
  container.innerHTML = "";

  const entregas = DATA.orders
    .filter((o) => isPedidoMotoboy(o) && o.status === "entregue" && o.entregueAt)
    .sort((a, b) => new Date(b.entregueAt) - new Date(a.entregueAt));

  if (entregas.length === 0) {
    container.innerHTML = `<div class="empty">Nenhuma entrega concluída até agora.</div>`;
    return;
  }

  entregas.forEach((o) => {
    const minutos = (new Date(o.entregueAt) - new Date(o.createdAt)) / 60000;
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">#${fmtNumero(o.numero)}</span>
        <span class="valor">${fmtMoney(o.total)}</span>
      </div>
      <div class="nome">${o.customer.nome}</div>
      <div class="meta">${o.customer.bairro ? o.customer.bairro + " — " : ""}${o.customer.endereco}</div>
      <div class="meta">🛵 ${o.entregadorNome || "Sem entregador"} · ${fmtDuracaoMin(minutos)}</div>
      <div class="meta">Entregue em ${fmtDateTime(o.entregueAt)}</div>
    `;
    container.appendChild(div);
  });
}

function openEntregasModal() {
  const overlay = document.getElementById("entregas-modal-overlay");
  if (!overlay) return;
  renderEntregas();
  overlay.style.display = "flex";
}

function closeEntregasModal() {
  const overlay = document.getElementById("entregas-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

// Chave usada para identificar um cliente de forma consistente (telefone
// quando existir, senão o nome) — a mesma lógica já usada no agrupamento
// do Histórico de Clientes.
function getClienteKey(c) {
  return c.telefone || c.nome;
}

function isClienteVip(key) {
  return DATA.clientesVip.includes(key);
}

function toggleClienteVip(key) {
  refreshDataFromStorage();
  if (DATA.clientesVip.includes(key)) {
    DATA.clientesVip = DATA.clientesVip.filter((k) => k !== key);
  } else {
    DATA.clientesVip.push(key);
  }
  saveData();
  renderHistorico();
}

// Pontos de fidelidade acumulados por um cliente, com base no total geral
// gasto (histórico completo, sem filtro de período).
function calcularPontosCliente(totalGastoGeral) {
  return Math.floor((totalGastoGeral || 0) * PONTOS_POR_REAL);
}

// Total de cashback já resgatado por um cliente (soma de todos os resgates).
function totalCashbackResgatado(key) {
  return DATA.cashbackResgates.filter((r) => r.clienteKey === key).reduce((acc, r) => acc + r.valor, 0);
}

// Saldo de cashback disponível para resgate: % do total gasto − já resgatado.
function calcularSaldoCashback(totalGastoGeral, key) {
  const ganho = (totalGastoGeral || 0) * CASHBACK_PERCENT;
  const resgatado = totalCashbackResgatado(key);
  return Math.max(0, Math.round((ganho - resgatado) * 100) / 100);
}

// Registra o resgate de cashback de um cliente: pergunta o valor (limitado ao
// saldo disponível) e guarda no histórico, sem mexer no caixa/estoque.
function resgatarCashback(key, nome, saldoDisponivel) {
  if (saldoDisponivel <= 0) {
    toast("Este cliente não tem saldo de cashback disponível.");
    return;
  }
  const valorStr = prompt(`Valor do cashback a resgatar para ${nome} (disponível: ${fmtMoney(saldoDisponivel)}):`);
  if (valorStr === null) return;
  const valor = Number(String(valorStr).replace(",", "."));
  if (isNaN(valor) || valor <= 0) {
    toast("Informe um valor válido.");
    return;
  }
  if (valor > saldoDisponivel) {
    toast("Valor maior que o saldo disponível.");
    return;
  }

  refreshDataFromStorage();
  DATA.cashbackResgates.unshift({
    id: uid("csb"),
    clienteKey: key,
    nome,
    valor: Math.round(valor * 100) / 100,
    registradoEm: new Date().toISOString(),
  });
  saveData();
  renderHistorico();
  toast("Cashback resgatado.");
}

// Data de aniversário de um cliente, no formato "MM-DD" (ou null se não cadastrada).
function getAniversarioCliente(key) {
  return DATA.clientesAniversarios[key] || null;
}

// Formata "MM-DD" para exibição "DD/MM".
function fmtAniversario(mmdd) {
  const [mm, dd] = mmdd.split("-");
  return `${dd}/${mm}`;
}

// Pede a data de aniversário (formato DD/MM) e salva/atualiza no cadastro.
// Enviar em branco remove o cadastro (útil para corrigir um cadastro errado).
function definirAniversarioCliente(key, nome) {
  const atual = getAniversarioCliente(key);
  const entrada = prompt(
    `Data de aniversário de ${nome} (formato DD/MM):`,
    atual ? fmtAniversario(atual) : ""
  );
  if (entrada === null) return;

  refreshDataFromStorage();

  const texto = entrada.trim();
  if (texto === "") {
    delete DATA.clientesAniversarios[key];
    saveData();
    renderHistorico();
    toast("Aniversário removido.");
    return;
  }

  const m = texto.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!m) {
    toast("Formato inválido. Use DD/MM (ex: 25/12).");
    return;
  }
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    toast("Data inválida.");
    return;
  }

  DATA.clientesAniversarios[key] = `${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  saveData();
  renderHistorico();
  toast("Aniversário salvo.");
}

// Lista os clientes cujo aniversário cai no mês atual, ordenados por dia,
// destacando quem faz aniversário hoje.
function renderAniversariantes(clientesBasicos) {
  const container = document.getElementById("aniversariantes-list");
  if (!container) return;

  const hoje = new Date();
  const mesAtual = String(hoje.getMonth() + 1).padStart(2, "0");
  const diaHoje = String(hoje.getDate()).padStart(2, "0");

  const aniversariantes = Object.keys(clientesBasicos)
    .map((key) => {
      const aniversario = getAniversarioCliente(key);
      if (!aniversario) return null;
      const [mm, dd] = aniversario.split("-");
      if (mm !== mesAtual) return null;
      return { key, nome: clientesBasicos[key].nome, dd, hoje: dd === diaHoje };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.dd) - Number(b.dd));

  if (aniversariantes.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum aniversariante cadastrado para este mês.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="ranking-list">
      ${aniversariantes
        .map(
          (a) => `
        <div class="ranking-row">
          <div class="nome">${a.nome}</div>
          <div class="valor">${a.dd}/${mesAtual}${a.hoje ? ` <span class="tag vip" style="margin-left:4px;">🎂 Hoje!</span>` : ""}</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

// Quantos dias se passaram desde o último pedido do cliente.
function calcularDiasInativo(ultimoPedidoISO) {
  if (!ultimoPedidoISO) return 0;
  const ms = Date.now() - new Date(ultimoPedidoISO).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

function isClienteInativo(ultimoPedidoISO) {
  return calcularDiasInativo(ultimoPedidoISO) > INATIVO_DIAS;
}

// Lista os clientes que não fazem pedido há mais de INATIVO_DIAS dias,
// ordenados do mais inativo para o menos inativo.
function renderClientesInativos(clientesBasicos) {
  const container = document.getElementById("clientes-inativos-list");
  if (!container) return;

  const inativos = Object.keys(clientesBasicos)
    .map((key) => {
      const c = clientesBasicos[key];
      const dias = calcularDiasInativo(c.ultimoPedido);
      if (dias <= INATIVO_DIAS) return null;
      return { key, nome: c.nome, dias, ultimoPedido: c.ultimoPedido };
    })
    .filter(Boolean)
    .sort((a, b) => b.dias - a.dias);

  if (inativos.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum cliente inativo (mais de ${INATIVO_DIAS} dias sem pedido).</div>`;
    return;
  }

  container.innerHTML = `
    <div class="ranking-list">
      ${inativos
        .map(
          (c) => `
        <div class="ranking-row">
          <div class="nome">${c.nome}</div>
          <div class="valor">${c.dias} dias sem pedir <span class="tag inativo" style="margin-left:4px;">Inativo</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

/* ---------- Custo e previsão de faturamento (lucro) ---------- */

// Custo unitário de um item do cardápio, somando o custo de cada
// ingrediente da receita (MENU_RECIPE) proporcional à quantidade usada.
function custoUnitarioMenu(menuId) {
  const receita = MENU_RECIPE[menuId];
  if (!receita) return 0;
  return receita.reduce((acc, r) => {
    const stockItem = DATA.stock.find((s) => s.id === r.stockId);
    const custoItem = stockItem ? Number(stockItem.custo) || 0 : 0;
    return acc + custoItem * r.qtd;
  }, 0);
}

// Lucro previsto de um pedido: soma, item a item, (preço de venda − custo) × qtd.
function calcularLucroPedido(order) {
  return order.items.reduce((acc, i) => {
    const custoUnit = custoUnitarioMenu(i.menuId);
    return acc + (i.preco - custoUnit) * i.qtd;
  }, 0);
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw);
    // garante que todas as chaves existam mesmo se o storage for antigo
    const base = defaultData();
    return Object.assign(base, parsed);
  } catch (e) {
    console.error("Erro ao carregar dados, iniciando do zero.", e);
    return defaultData();
  }
}

// Recarrega DATA a partir do que está salvo no localStorage agora mesmo.
// Usado antes de qualquer ação que vá alterar e salvar dados, para evitar que
// esta aba/janela sobrescreva (e "desfaça") mudanças feitas em outra aba com
// uma cópia mais antiga dos dados em memória (ex: pedido marcado como
// finalizado em uma aba, enquanto outra aba, desatualizada, cria um pedido novo).
function refreshDataFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    DATA = Object.assign(defaultData(), parsed);
  } catch (e) {
    // se não der pra ler o storage agora, segue com os dados atuais em memória
  }
}

// Sincronização entre abas: quando outra aba/janela desta mesma aplicação salva
// alterações no localStorage (ex: dono avança o status de um pedido em uma aba),
// esta aba recarrega os dados mais recentes e re-renderiza a página atual —
// evitando que esta aba, com dados antigos, sobrescreva essas mudanças depois.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  refreshDataFromStorage();
  rerenderPaginaAtual();
});

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
  } catch (e) {
    console.error("Não foi possível salvar os dados neste navegador.", e);
    toast("Aviso: não foi possível salvar os dados neste navegador.");
  }
  // Envia também para a nuvem (Firebase), se estiver configurado, para que
  // outros dispositivos (celular, outro computador etc.) recebam a mudança
  // em tempo real. Não bloqueia o salvamento local se a nuvem falhar.
  if (firebaseReady && firebaseDb) {
    firebaseDb
      .collection(FIRESTORE_COLLECTION)
      .doc(FIRESTORE_DOC)
      .set(DATA)
      .catch((e) => console.error("Não foi possível sincronizar com a nuvem.", e));
  }
}

/* ---------- Toast ---------- */

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

/* ---------- Login e permissões por usuário ---------- */

// Usuário logado neste navegador/dispositivo (só existe em index.html). Retorna
// null se ninguém logou ainda ou se o usuário salvo foi removido/desativado.
function getUsuarioLogado() {
  let id = null;
  try {
    id = localStorage.getItem(LOGIN_STORAGE_KEY);
  } catch (e) {
    // Sem acesso ao localStorage neste navegador/contexto: trata como
    // "ninguém logado" em vez de travar o restante do app.
    id = null;
  }
  if (!id) return null;
  return DATA.usuarios.find((u) => u.id === id && u.ativo) || null;
}

// Preenche o select de usuários da tela de login com os usuários ativos.
function popularSelectLogin() {
  const select = document.getElementById("login-usuario");
  if (!select) return;
  select.innerHTML = DATA.usuarios
    .filter((u) => u.ativo)
    .map((u) => `<option value="${u.id}">${u.nome}</option>`)
    .join("");
}

function mostrarTelaLogin() {
  const overlay = document.getElementById("login-overlay");
  if (!overlay) return;
  // Esconde todo o painel (topo, abas e conteúdo) — só o card de login fica
  // visível, numa página em branco. Isso impede que qualquer visitante veja
  // o gerenciador antes de logar com um usuário já cadastrado (não existe
  // tela pública de criação de conta).
  const app = document.querySelector(".app");
  if (app) app.classList.remove("autenticado");
  popularSelectLogin();
  overlay.style.display = "flex";
  const pin = document.getElementById("login-pin");
  if (pin) pin.value = "";
}

function esconderTelaLogin() {
  const overlay = document.getElementById("login-overlay");
  if (overlay) overlay.style.display = "none";
  const app = document.querySelector(".app");
  if (app) app.classList.add("autenticado");
}

// Confere usuário + PIN escolhidos na tela de login e, se corretos, entra no painel.
function fazerLogin() {
  refreshDataFromStorage();
  const usuarioId = document.getElementById("login-usuario").value;
  const pin = document.getElementById("login-pin").value.trim();
  const usuario = DATA.usuarios.find((u) => u.id === usuarioId && u.ativo);
  if (!usuario) {
    toast("Selecione um usuário.");
    return;
  }
  if (usuario.pin !== pin) {
    toast("PIN incorreto.");
    return;
  }
  try {
    localStorage.setItem(LOGIN_STORAGE_KEY, usuario.id);
  } catch (e) {
    console.error("Não foi possível salvar o login neste navegador.", e);
  }
  // Só bate a entrada no primeiro login do dia — logins seguintes no mesmo
  // dia (ex.: saiu e voltou) não geram uma nova entrada.
  if (usuario.funcionarioId && !temEntradaHoje(usuario.funcionarioId)) {
    baterPonto(usuario.funcionarioId, "entrada");
  }
  aplicarPermissoes();
  renderAll();
}

// O logout NÃO bate ponto de saída — a saída só é registrada quando o dia é
// finalizado (botão "Dia finalizado"), representando a última saída do dia.
function fazerLogout() {
  refreshDataFromStorage();
  try {
    localStorage.removeItem(LOGIN_STORAGE_KEY);
  } catch (e) {
    // ignora — sem acesso ao localStorage não há o que limpar
  }
  aplicarPermissoes();
}

// Funcionários cujo último registro de ponto é uma "entrada" sem uma "saída"
// depois — ou seja, ainda não tiveram o dia finalizado.
function funcionariosComPontoAberto() {
  return DATA.funcionarios.filter((f) => {
    const registros = DATA.registrosPonto
      .filter((r) => r.funcionarioId === f.id)
      .sort((a, b) => new Date(b.horario) - new Date(a.horario));
    return registros.length > 0 && registros[0].tipo === "entrada";
  });
}

// Botão "Dia finalizado" na página de Pedidos: fecha o ponto de todos os
// funcionários que ainda estão com entrada em aberto (registra a saída de
// cada um), mas SEM deslogar do painel — diferente de fazerLogout().
function finalizarDia() {
  refreshDataFromStorage();
  const abertos = funcionariosComPontoAberto();
  abertos.forEach((f) => baterPonto(f.id, "saida"));
  if (abertos.length > 0) {
    toast(`Dia finalizado. Saída registrada para ${abertos.length} funcionário${abertos.length === 1 ? "" : "s"}.`);
  } else {
    toast("Dia finalizado.");
  }
}

// Contagem de usuários "Dono" ativos — usada para nunca deixar o dono ficar
// sem nenhum usuário capaz de gerenciar os outros usuários.
function contarDonosAtivos() {
  return DATA.usuarios.filter((u) => u.papel === "dono" && u.ativo).length;
}

// Ajusta o painel (tela de login, abas visíveis, nome do usuário no topo, botão
// Sair) de acordo com o usuário logado e o papel dele. Só se aplica a
// index.html — o cardápio do cliente (cardapio.html) não tem nav.tabs.
function aplicarPermissoes() {
  const nav = document.querySelector("nav.tabs");
  if (!nav) return;

  const usuario = getUsuarioLogado();
  const nomeEl = document.getElementById("usuario-logado-nome");
  const logoutBtn = document.getElementById("btn-logout");

  if (!usuario) {
    if (nomeEl) nomeEl.textContent = "";
    if (logoutBtn) logoutBtn.style.display = "none";
    mostrarTelaLogin();
    return;
  }

  esconderTelaLogin();
  if (nomeEl) nomeEl.textContent = `${usuario.nome} (${PAPEL_LABEL[usuario.papel] || usuario.papel})`;
  if (logoutBtn) logoutBtn.style.display = "";

  const permissoes = PAPEIS_PERMISSOES[usuario.papel] || {};
  let primeiraPermitida = null;
  nav.querySelectorAll("button[data-page]").forEach((btn) => {
    const permitido = !!permissoes[btn.dataset.page];
    btn.style.display = permitido ? "" : "none";
    if (permitido && !primeiraPermitida) primeiraPermitida = btn.dataset.page;
  });

  const ativoAtual = nav.querySelector("button.active");
  const aindaPermitido = ativoAtual && permissoes[ativoAtual.dataset.page];
  if (!aindaPermitido && primeiraPermitida) showPage(primeiraPermitida);
}

/* ---------- Navegação ---------- */

function initNav() {
  document.querySelectorAll("nav.tabs button").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });
}

function showPage(pageId) {
  const target = document.getElementById("page-" + pageId);
  if (!target) return;
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.remove("active"));
  target.classList.add("active");
  const btn = document.querySelector(`nav.tabs button[data-page="${pageId}"]`);
  if (btn) btn.classList.add("active");
  renderPage(pageId);
}

function renderPage(pageId) {
  if (pageId === "cardapio") renderCardapio();
  if (pageId === "pedidos") renderPedidos();
  if (pageId === "caixa") renderCaixa();
  if (pageId === "estoque") renderEstoque();
  if (pageId === "entrega") renderEntrega();
  if (pageId === "colaboradores") renderColaboradores();
  if (pageId === "historico") renderHistorico();
  if (pageId === "relatorios") renderRelatorios();
}

function renderAll() {
  renderCardapio();
  renderPedidos();
  renderCaixa();
  renderEstoque();
  renderHistorico();
  renderRelatorios();
}

/* ===================================================
   PAGINA: CARDAPIO / PEDIDO (cliente)
   =================================================== */

let CART = {}; // { menuId: qtd }

// Id do pedido que o cliente está acompanhando em tempo real no cardapio.html
// (null quando nenhum pedido está sendo acompanhado, ex: página do dono).
let ACOMPANHAR_PEDIDO_ID = null;

// Ícones por categoria — só usados no cardápio do cliente (cardapio.html),
// para deixar a lista mais convidativa e fácil de escanear visualmente. O
// painel do dono (index.html) reaproveita renderCardapio() para o pedido de
// balcão/mesa e continua sem ícones, minimalista.
const CATEGORIA_ICONE = {
  "Espetos Premium": "🍢",
  "Medalhões": "🍗",
  "Jantinha": "🍽️",
  "Acompanhamentos": "🥖",
};

function renderCardapio() {
  const container = document.getElementById("menu-list");
  if (!container) return;
  container.innerHTML = "";

  const isClienteView = document.body.classList.contains("cardapio-client");

  const categorias = [...new Set(DATA.menu.map((m) => m.categoria))];
  categorias.forEach((cat) => {
    const title = document.createElement("div");
    title.className = "section-title";
    const icone = CATEGORIA_ICONE[cat];
    title.textContent = isClienteView && icone ? `${icone} ${cat}` : cat;
    container.appendChild(title);

    const list = document.createElement("div");
    list.className = "menu-list";

    DATA.menu.filter((m) => m.categoria === cat).forEach((item) => {
      const qty = CART[item.id] || 0;
      const row = document.createElement("div");
      row.className = "menu-item" + (qty > 0 ? " tem-qtd" : "");
      row.innerHTML = `
        <div class="info">
          <strong>${item.nome}</strong>
          ${item.desc ? `<div class="desc">${item.desc}</div>` : ""}
        </div>
        <div style="display:flex; align-items:center;">
          <div class="price">${fmtMoney(item.preco)}</div>
          <div class="qty-control">
            <button data-act="menos" data-id="${item.id}">−</button>
            <span id="qty-${item.id}">${qty}</span>
            <button data-act="mais" data-id="${item.id}">+</button>
          </div>
        </div>
      `;
      list.appendChild(row);
    });
    container.appendChild(list);
  });

  container.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const cur = CART[id] || 0;
      if (btn.dataset.act === "mais") CART[id] = cur + 1;
      else CART[id] = Math.max(0, cur - 1);
      if (CART[id] === 0) delete CART[id];
      document.getElementById("qty-" + id).textContent = CART[id] || 0;
      const row = btn.closest(".menu-item");
      if (row) row.classList.toggle("tem-qtd", (CART[id] || 0) > 0);
      renderCart();
    });
  });

  renderCart();
  toggleEntregaFields();
}

function renderCart() {
  const box = document.getElementById("cart-lines");
  box.innerHTML = "";
  let total = 0;
  const ids = Object.keys(CART);
  if (ids.length === 0) {
    box.innerHTML = `<div class="empty">Nenhum item selecionado</div>`;
  } else {
    ids.forEach((id) => {
      const item = DATA.menu.find((m) => m.id === id);
      const qty = CART[id];
      const subtotal = item.preco * qty;
      total += subtotal;
      const line = document.createElement("div");
      line.className = "cart-line";
      line.innerHTML = `<span>${qty}x ${item.nome}</span><span>${fmtMoney(subtotal)}</span>`;
      box.appendChild(line);
    });
  }

  const taxaEntregaEl = document.getElementById("f-taxa-entrega");
  const taxaEntrega = taxaEntregaEl ? Number(taxaEntregaEl.value || 0) : 0;
  const tipoEntrega = document.getElementById("f-tipo-entrega").value;
  const totalFinal = total + (tipoEntrega === "entrega" ? taxaEntrega : 0);

  document.getElementById("cart-total").textContent = fmtMoney(totalFinal);
  document.getElementById("btn-enviar-pedido").disabled = ids.length === 0;
}

function toggleEntregaFields() {
  const tipo = document.getElementById("f-tipo-entrega").value;
  const camposEntrega = document.getElementById("campos-entrega");
  if (camposEntrega) camposEntrega.style.display = tipo === "entrega" ? "block" : "none";
  const campoMesa = document.getElementById("campo-mesa");
  if (campoMesa) campoMesa.style.display = tipo === "mesa" ? "block" : "none";
  renderCart();
}

function togglePagamentoFields() {
  const pg = document.getElementById("f-pagamento").value;
  document.getElementById("campo-troco").style.display = pg === "dinheiro" ? "block" : "none";
}

// Acompanhamento em tempo real do pedido (cardapio.html): o app não tem
// backend/websocket, então o "tempo real" aproveita o evento nativo "storage"
// (já usado para sincronizar as páginas do dono entre abas) + um polling curto
// como reforço, para refletir mudanças de status feitas pelo dono em outra aba.
function mostrarAcompanhamentoPedido() {
  const painel = document.getElementById("acompanhar-pedido");
  if (!painel) return; // só existe no cardapio.html
  const area = document.getElementById("cardapio-pedido-area");
  if (area) area.style.display = "none";
  painel.style.display = "block";
  renderAcompanhamentoPedido();
}

function esconderAcompanhamentoPedido() {
  ACOMPANHAR_PEDIDO_ID = null;
  const painel = document.getElementById("acompanhar-pedido");
  const area = document.getElementById("cardapio-pedido-area");
  if (painel) painel.style.display = "none";
  if (area) area.style.display = "";
  renderCardapio();
}

function renderAcompanhamentoPedido() {
  const container = document.getElementById("acompanhar-conteudo");
  if (!container || !ACOMPANHAR_PEDIDO_ID) return;

  refreshDataFromStorage();
  const order = DATA.orders.find((o) => o.id === ACOMPANHAR_PEDIDO_ID);
  if (!order) {
    container.innerHTML = `<div class="empty">Pedido não encontrado.</div>`;
    return;
  }

  const motoboy = isPedidoMotoboy(order);
  const passos = [
    { key: "aberto", label: "Pedido recebido" },
    { key: motoboy ? "aguardando_motoboy" : "aguardando_balcao", label: motoboy ? "Saiu para entrega" : "Pronto para retirada" },
    { key: "entregue", label: motoboy ? "Entregue" : "Retirado" },
  ];
  const idxAtual = passos.findIndex((p) => p.key === order.status);

  const mostrarPix = order.customer.pagamento === "pix" && !order.pago;

  container.innerHTML = `
    <div class="ranking-list">
      ${passos
        .map(
          (p, i) => `
        <div class="ranking-row">
          <div class="nome">${i <= idxAtual ? "✅" : "⏳"} ${p.label}</div>
        </div>
      `
        )
        .join("")}
    </div>
    <p style="margin-top:12px; color:var(--muted); font-size:13px;">
      Pedido nº ${order.numero} — ${STATUS_LABEL[order.status]}${order.entregadorNome ? " · Entregador: " + order.entregadorNome : ""}
    </p>
    ${
      mostrarPix
        ? `
    <div class="card" id="pix-pagamento-box" style="margin-top:16px;">
      <h3>Pagamento via Pix</h3>
      <p style="color:var(--muted); font-size:13px; margin-bottom:12px;">
        Escaneie o QR Code ou copie o código abaixo para pagar ${fmtMoney(order.total)}. Depois, envie o comprovante no WhatsApp.
      </p>
      <div id="pix-qrcode-canvas" style="display:flex; justify-content:center; margin-bottom:12px;"></div>
      <button class="btn secondary" id="btn-copiar-pix" type="button" style="width:100%;">Copiar código Pix</button>
      <a class="btn" id="btn-comprovante-whats" href="${WHATSAPP_COMPROVANTE_LINK}" target="_blank" rel="noopener"
         style="display:block; text-align:center; width:100%; margin-top:8px; text-decoration:none;">
        Enviar comprovante no WhatsApp
      </a>
    </div>
    `
        : ""
    }
  `;

  if (mostrarPix) {
    const pixPayload = PIX_BRCODE;
    renderPixQRCode(pixPayload);
    const btnCopiar = document.getElementById("btn-copiar-pix");
    if (btnCopiar) {
      btnCopiar.addEventListener("click", () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard
            .writeText(pixPayload)
            .then(() => toast("Código Pix copiado!"))
            .catch(() => toast("Não foi possível copiar. Copie manualmente."));
        } else {
          toast("Não foi possível copiar. Copie manualmente.");
        }
      });
    }
  }
}

function renderPixQRCode(payload) {
  const el = document.getElementById("pix-qrcode-canvas");
  if (!el) return;
  el.innerHTML = "";
  if (typeof QRCode === "undefined") {
    el.innerHTML = `<p style="color:var(--muted); font-size:12px;">Não foi possível carregar o QR Code. Use o código copiado.</p>`;
    return;
  }
  new QRCode(el, {
    text: payload,
    width: 200,
    height: 200,
    colorDark: "#000000",
    colorLight: "#ffffff",
  });
}

function enviarPedido() {
  const ids = Object.keys(CART);
  if (ids.length === 0) return;

  // Garante que estamos partindo dos dados mais recentes salvos (evita sobrescrever
  // mudanças feitas em outra aba, como um pedido marcado como finalizado).
  refreshDataFromStorage();

  const isGerenciador = !!document.getElementById("pedidos-list");

  const nome = document.getElementById("f-nome").value.trim();
  const telefone = document.getElementById("f-telefone").value.trim();
  const tipoEntrega = document.getElementById("f-tipo-entrega").value;
  const endereco = document.getElementById("f-endereco") ? document.getElementById("f-endereco").value.trim() : "";
  const referencia = document.getElementById("f-referencia") ? document.getElementById("f-referencia").value.trim() : "";
  const taxaEntrega = document.getElementById("f-taxa-entrega") ? Number(document.getElementById("f-taxa-entrega").value || 0) : 0;
  const bairroSelect = document.getElementById("f-bairro");
  const bairroSelecionado = bairroSelect && bairroSelect.value ? DATA.bairros.find((b) => b.id === bairroSelect.value) : null;
  const bairroNome = bairroSelecionado ? bairroSelecionado.nome : "";
  const mesa = document.getElementById("f-mesa") ? document.getElementById("f-mesa").value.trim() : "";
  const pagamento = document.getElementById("f-pagamento").value;
  const troco = document.getElementById("f-troco").value.trim();
  const obs = document.getElementById("f-obs").value.trim();
  const jaPago = document.getElementById("f-ja-pago") ? document.getElementById("f-ja-pago").checked : false;

  const telefoneObrigatorio = tipoEntrega === "entrega" || tipoEntrega === "retirada";
  if (!nome || (telefoneObrigatorio && !telefone)) {
    toast(telefoneObrigatorio ? "Preencha nome e telefone." : "Preencha o nome do cliente.");
    return;
  }
  if (tipoEntrega === "entrega" && !endereco) {
    toast("Preencha o endereço de entrega.");
    return;
  }
  if (tipoEntrega === "mesa" && !mesa) {
    toast("Informe o número da mesa.");
    return;
  }

  const items = ids.map((id) => {
    const m = DATA.menu.find((x) => x.id === id);
    return { menuId: id, nome: m.nome, preco: m.preco, qtd: CART[id] };
  });

  const subtotal = items.reduce((acc, i) => acc + i.preco * i.qtd, 0);
  const total = subtotal + (tipoEntrega === "entrega" ? taxaEntrega : 0);

  const hoje = todayISO();
  const numero = DATA.orders.filter((o) => o.createdAt.slice(0, 10) === hoje).length + 1;

  const order = {
    id: uid("ped"),
    numero,
    createdAt: new Date().toISOString(),
    status: "aberto",
    origem: isGerenciador ? "balcao" : "cliente",
    pago: jaPago,
    cashPosted: false,
    stockPosted: false,
    customer: {
      nome,
      telefone,
      tipoEntrega,
      mesa: tipoEntrega === "mesa" ? mesa : "",
      endereco: tipoEntrega === "entrega" ? endereco : "",
      referencia: tipoEntrega === "entrega" ? referencia : "",
      bairro: tipoEntrega === "entrega" ? bairroNome : "",
      taxaEntrega: tipoEntrega === "entrega" ? taxaEntrega : 0,
      pagamento,
      troco: pagamento === "dinheiro" ? troco : "",
      obs,
    },
    entregadorId: "",
    entregadorNome: "",
    funcionarioId: "",
    funcionarioNome: "",
    items,
    subtotal,
    total,
  };

  DATA.orders.unshift(order);
  ajustarEstoquePorPedido(order, -1);
  order.stockPosted = true;
  if (order.pago) postOrderToCash(order);
  saveData();

  CART = {};
  document.getElementById("form-pedido").reset();
  if (document.getElementById("f-taxa-entrega")) document.getElementById("f-taxa-entrega").value = 0;
  if (document.getElementById("f-bairro")) document.getElementById("f-bairro").value = "";
  if (document.getElementById("f-mesa")) document.getElementById("f-mesa").value = "";
  if (document.getElementById("f-ja-pago")) document.getElementById("f-ja-pago").checked = false;
  toggleEntregaFields();
  togglePagamentoFields();
  renderCardapio();

  toast(isGerenciador ? "Pedido do balcão/mesa registrado." : "Pedido enviado! Já apareceu para o dono na aba Pedidos.");
  renderPedidos();
  renderCaixa();
  renderEstoque();

  if (!isGerenciador && document.getElementById("acompanhar-pedido")) {
    ACOMPANHAR_PEDIDO_ID = order.id;
    mostrarAcompanhamentoPedido();
  }

  if (isGerenciador) {
    const panel = document.getElementById("balcao-panel");
    const btnToggle = document.getElementById("btn-toggle-balcao");
    if (panel) panel.style.display = "none";
    if (btnToggle) btnToggle.textContent = "+ Novo pedido (Balcão/Mesa)";
  }
}

/* ===================================================
   PAGINA: PEDIDOS (dono)
   =================================================== */

function renderPedidos() {
  atualizarBadgeCancelamentos();

  const container = document.getElementById("pedidos-list");
  if (!container) return;
  const filtro = document.getElementById("filtro-status") ? document.getElementById("filtro-status").value : "todos";
  const verTodosDias = document.getElementById("filtro-todos-dias") ? document.getElementById("filtro-todos-dias").checked : false;
  const dataFiltro = document.getElementById("filtro-data-pedidos") ? document.getElementById("filtro-data-pedidos").value : "";
  container.innerHTML = "";

  let orders = DATA.orders;
  if (filtro !== "todos") orders = orders.filter((o) => o.status === filtro);
  // Por padrão só mostra os pedidos do dia selecionado (hoje, na primeira
  // abertura), para pedidos de dias anteriores não ficarem misturados na
  // tela. O dono pode marcar "Ver todos os dias" para ver o histórico inteiro.
  if (!verTodosDias && dataFiltro) orders = orders.filter((o) => (o.createdAt || "").slice(0, 10) === dataFiltro);

  if (orders.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum pedido encontrado</div>`;
    return;
  }

  const board = document.createElement("div");
  board.className = "pedidos-board";

  STATUS_GROUPS.forEach((group) => {
    const groupOrders = orders.filter((o) => group.statuses.includes(o.status));

    // Mesma classe "card" para os 3 grupos, então ficam idênticos entre si.
    const groupCard = document.createElement("div");
    groupCard.className = "card pedidos-group";
    groupCard.innerHTML = `<div class="pedidos-group-header"><h3>${group.label}</h3><span class="count-badge">${groupOrders.length}</span></div>`;

    const list = document.createElement("div");
    list.className = "pedidos-compact-list";

    if (groupOrders.length === 0) {
      list.innerHTML = `<div class="empty small">Nenhum pedido</div>`;
    } else {
      groupOrders.forEach((o) => list.appendChild(buildPedidoCompactCard(o)));
    }

    groupCard.appendChild(list);
    board.appendChild(groupCard);
  });

  container.appendChild(board);

  container.querySelectorAll("button[data-act='ver-pedido']").forEach((btn) => {
    btn.addEventListener("click", () => openPedidoModal(btn.dataset.id));
  });
  container.querySelectorAll("button[data-act='avancar-rapido']").forEach((btn) => {
    btn.addEventListener("click", () => handlePedidoAction("avancar", btn.dataset.id));
  });
}

function buildPedidoCompactCard(o) {
  const div = document.createElement("div");
  div.className = "pedido-compact-card";
  const avancarLabel = getAvancarLabel(o);
  div.innerHTML = `
    <div class="row-top">
      <span class="numero">#${fmtNumero(getOrderNumero(o))}</span>
      <span class="valor">${fmtMoney(o.total)}</span>
    </div>
    <div class="nome">${o.customer.nome}</div>
    <div class="meta">${fmtDateTime(o.createdAt)}</div>
    ${o.customer.tipoEntrega === "entrega" ? `<div class="meta">🛵 ${o.entregadorNome || "Sem entregador"}</div>` : ""}
    <div class="tags-row">
      <span class="tag ${o.status}">${STATUS_LABEL[o.status]}</span>
      <span class="tag ${o.pago ? "pago" : "pendente"}">${o.pago ? "Pago" : "Pendente"}</span>
    </div>
    <button class="btn small secondary" data-act="ver-pedido" data-id="${o.id}">Ver pedido</button>
    ${avancarLabel ? `<button class="btn small" data-act="avancar-rapido" data-id="${o.id}">${avancarLabel}</button>` : ""}
  `;
  return div;
}

function pedidoDetalheHtml(o) {
  const itemsHtml = o.items.map((i) => `${i.qtd}x ${i.nome} — ${fmtMoney(i.preco * i.qtd)}`).join("<br>");

  const entregaInfo =
    o.customer.tipoEntrega === "entrega"
      ? `Entrega${o.customer.bairro ? " (" + o.customer.bairro + ")" : ""}: ${o.customer.endereco}${o.customer.referencia ? " (" + o.customer.referencia + ")" : ""}${o.customer.taxaEntrega ? " — Taxa " + fmtMoney(o.customer.taxaEntrega) : ""}`
      : o.customer.tipoEntrega === "mesa"
      ? `Mesa: ${o.customer.mesa}`
      : o.customer.tipoEntrega === "retirada"
      ? "Retirada no local"
      : "Balcão (pedido no local)";

  const origemInfo = o.origem === "balcao" ? "Balcão/Mesa" : "Cliente (cardápio)";

  const pagInfo =
    o.customer.pagamento === "dinheiro"
      ? `Dinheiro${o.customer.troco ? " — troco para " + o.customer.troco : ""}`
      : o.customer.pagamento === "pix"
      ? "Pix"
      : "Cartão";

  const nextStatus = getNextStatus(o);
  const avancarLabel = getAvancarLabel(o);

  return `
    <div class="modal-header">
      <div class="numero-grande">#${fmtNumero(getOrderNumero(o))}</div>
      <div>
        <strong>${o.customer.nome}</strong>${o.customer.telefone ? " — " + o.customer.telefone : ""}
        <div class="meta">${fmtDateTime(o.createdAt)} · ${origemInfo}</div>
      </div>
    </div>
    <div style="margin:10px 0;">
      <span class="tag ${o.status}">${STATUS_LABEL[o.status]}</span>
      <span class="tag ${o.pago ? "pago" : "pendente"}" style="margin-left:6px;">${o.pago ? "Pago" : "Pendente"}</span>
    </div>
    <div class="order-items">${itemsHtml}</div>
    <div class="meta">${entregaInfo}</div>
    <div class="meta">Pagamento: ${pagInfo}</div>
    ${o.customer.obs ? `<div class="meta">Obs: ${o.customer.obs}</div>` : ""}
    ${
      o.customer.tipoEntrega === "entrega"
        ? `<div class="field" style="margin-top:10px;">
      <label>Entregador</label>
      <select id="sel-entregador">
        <option value="">Sem entregador</option>
        ${DATA.entregadores
          .filter((e) => e.ativo || e.id === o.entregadorId)
          .map((e) => `<option value="${e.id}" ${e.id === o.entregadorId ? "selected" : ""}>${e.nome}${e.ativo ? "" : " (inativo)"}</option>`)
          .join("")}
      </select>
    </div>`
        : ""
    }
    <div class="field" style="margin-top:10px;">
      <label>Funcionário responsável</label>
      <select id="sel-funcionario">
        <option value="">Sem funcionário</option>
        ${DATA.funcionarios
          .filter((f) => f.ativo || f.id === o.funcionarioId)
          .map((f) => `<option value="${f.id}" ${f.id === o.funcionarioId ? "selected" : ""}>${f.nome}${f.ativo ? "" : " (inativo)"}</option>`)
          .join("")}
      </select>
    </div>
    <div class="meta"><strong>Total: ${fmtMoney(o.total)}</strong></div>
    <div class="order-actions">
      ${nextStatus ? `<button class="btn small" data-act="avancar" data-id="${o.id}">${avancarLabel} → ${STATUS_LABEL[nextStatus]}</button>` : ""}
      <button class="btn small secondary" data-act="pagar" data-id="${o.id}">${o.pago ? "Marcar pendente" : "Marcar como pago"}</button>
      <button class="btn small danger" data-act="cancelar" data-id="${o.id}">Cancelar pedido</button>
    </div>
  `;
}

function openPedidoModal(id) {
  const order = DATA.orders.find((o) => o.id === id);
  const overlay = document.getElementById("pedido-modal-overlay");
  const content = document.getElementById("pedido-modal-content");
  if (!order || !overlay || !content) return;

  content.innerHTML = pedidoDetalheHtml(order);
  content.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => handlePedidoAction(btn.dataset.act, btn.dataset.id));
  });
  const selEntregador = content.querySelector("#sel-entregador");
  if (selEntregador) {
    selEntregador.addEventListener("change", () => atribuirEntregador(id, selEntregador.value));
  }
  const selFuncionario = content.querySelector("#sel-funcionario");
  if (selFuncionario) {
    selFuncionario.addEventListener("change", () => atribuirFuncionario(id, selFuncionario.value));
  }

  overlay.style.display = "flex";
  overlay.dataset.orderId = id;
}

function closePedidoModal() {
  const overlay = document.getElementById("pedido-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
  delete overlay.dataset.orderId;
}

// Atualiza o badge de contagem no botão "Cancelamentos" da página de Pedidos.
function atualizarBadgeCancelamentos() {
  const badge = document.getElementById("badge-cancelamentos");
  if (!badge) return;
  const total = DATA.cancelamentos.length;
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

function renderCancelamentos() {
  atualizarBadgeCancelamentos();

  const container = document.getElementById("cancelamentos-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.cancelamentos.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum pedido cancelado até agora.</div>`;
    return;
  }

  DATA.cancelamentos.forEach((c) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">#${fmtNumero(c.numero)}</span>
        <span class="valor">${fmtMoney(c.total)}</span>
      </div>
      <div class="nome">${c.clienteNome}</div>
      <div class="meta">Cancelado em ${fmtDateTime(c.canceledAt)}</div>
      <div class="meta">Itens: ${c.itens.map((i) => `${i.qtd}x ${i.nome}`).join(", ")}</div>
      <div class="meta"><strong>Motivo:</strong> ${c.motivo}</div>
    `;
    container.appendChild(div);
  });
}

function openCancelamentosModal() {
  const overlay = document.getElementById("cancelamentos-modal-overlay");
  if (!overlay) return;
  renderCancelamentos();
  overlay.style.display = "flex";
}

function closeCancelamentosModal() {
  const overlay = document.getElementById("cancelamentos-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

function handlePedidoAction(act, id) {
  // Parte sempre dos dados mais recentes salvos, para não sobrescrever mudanças
  // feitas em outra aba (ex: pedido finalizado em uma aba, novo pedido em outra).
  refreshDataFromStorage();

  const order = DATA.orders.find((o) => o.id === id);
  if (!order) return;

  let cancelado = false;

  if (act === "avancar") {
    const next = getNextStatus(order);
    if (next) {
      order.status = next;
      if (next === "entregue") {
        order.pago = true;
        order.entregueAt = new Date().toISOString();
        if (!order.cashPosted) postOrderToCash(order);
      }
    }
  }
  if (act === "pagar") {
    order.pago = !order.pago;
    if (order.pago && !order.cashPosted) {
      postOrderToCash(order);
    }
  }
  if (act === "cancelar") {
    const motivo = prompt("Cancelar este pedido? Os itens voltam para o estoque.\nMotivo do cancelamento (opcional):");
    if (motivo !== null) {
      if (order.stockPosted) {
        ajustarEstoquePorPedido(order, 1);
        order.stockPosted = false;
      }
      DATA.cancelamentos.unshift({
        id: uid("cnl"),
        orderId: order.id,
        numero: getOrderNumero(order),
        clienteNome: order.customer.nome,
        itens: order.items.map((i) => ({ nome: i.nome, qtd: i.qtd })),
        total: order.total,
        motivo: motivo.trim() || "Não informado",
        canceledAt: new Date().toISOString(),
      });
      DATA.orders = DATA.orders.filter((o) => o.id !== id);
      cancelado = true;
    }
  }

  saveData();
  renderPedidos();
  renderCaixa();
  renderHistorico();
  renderEstoque();

  const overlay = document.getElementById("pedido-modal-overlay");
  if (cancelado) {
    closePedidoModal();
  } else if (overlay && overlay.dataset.orderId === id) {
    openPedidoModal(id);
  }
}

// sign = -1 para descontar do estoque (novo pedido), +1 para devolver (pedido cancelado)
function ajustarEstoquePorPedido(order, sign) {
  order.items.forEach((item) => {
    const receita = MENU_RECIPE[item.menuId];
    if (!receita) return;
    receita.forEach((r) => {
      const stockItem = DATA.stock.find((s) => s.id === r.stockId);
      if (!stockItem) return;
      const change = r.qtd * item.qtd * sign;
      stockItem.quantidade = Math.max(0, Math.round((stockItem.quantidade + change) * 100) / 100);
    });
  });
}

function postOrderToCash(order) {
  order.cashPosted = true;
  DATA.cash.unshift({
    id: uid("cx"),
    date: todayISO(),
    tipo: "entrada",
    origem: "pedido",
    orderId: order.id,
    descricao: `Pedido de ${order.customer.nome} (${order.items.map((i) => i.qtd + "x " + i.nome).join(", ")})`,
    valor: order.total,
  });
}

/* ===================================================
   PAGINA: FLUXO DE CAIXA
   =================================================== */

function renderCaixa() {
  const container = document.getElementById("caixa-list");
  if (!container) return;
  container.innerHTML = "";

  const entradas = DATA.cash.filter((c) => c.tipo === "entrada").reduce((a, c) => a + c.valor, 0);
  const saidas = DATA.cash.filter((c) => c.tipo === "saida").reduce((a, c) => a + c.valor, 0);
  const saldo = entradas - saidas;

  document.getElementById("stat-entradas").textContent = fmtMoney(entradas);
  document.getElementById("stat-saidas").textContent = fmtMoney(saidas);
  document.getElementById("stat-saldo").textContent = fmtMoney(saldo);

  // Previsão de faturamento = lucro previsto (venda − custo) dos pedidos já
  // lançados no caixa (cashPosted), usando o custo unitário de cada item.
  const pedidosFaturados = DATA.orders.filter((o) => o.cashPosted);
  const previsaoFaturamento = pedidosFaturados.reduce((acc, o) => acc + calcularLucroPedido(o), 0);
  const statPrevisao = document.getElementById("stat-previsao");
  const statPrevisaoSub = document.getElementById("stat-previsao-sub");
  if (statPrevisao) statPrevisao.textContent = fmtMoney(previsaoFaturamento);
  if (statPrevisaoSub) {
    const margem = entradas > 0 ? (previsaoFaturamento / entradas) * 100 : 0;
    statPrevisaoSub.textContent = entradas > 0 ? `Margem de ${margem.toFixed(0)}% sobre as entradas` : "Cadastre o custo dos itens no Estoque";
  }

  if (DATA.cash.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum lançamento ainda</div>`;
    renderGraficosCaixa();
    popularSelectOperador();
    renderCaixaPorOperador();
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Valor</th><th></th></tr>
    </thead>
    <tbody>
      ${DATA.cash
        .map(
          (c) => `
        <tr>
          <td>${fmtDate(c.date)}</td>
          <td>${c.tipo === "entrada" ? "Entrada" : "Saída"}</td>
          <td>${c.descricao}</td>
          <td>${c.tipo === "entrada" ? "+" : "-"} ${fmtMoney(c.valor)}</td>
          <td>${c.origem === "manual" ? `<button class="btn small danger" data-act="del-cash" data-id="${c.id}">Remover</button>` : ""}</td>
        </tr>
      `
        )
        .join("")}
    </tbody>
  `;
  container.appendChild(table);

  container.querySelectorAll("button[data-act='del-cash']").forEach((btn) => {
    btn.addEventListener("click", () => {
      DATA.cash = DATA.cash.filter((c) => c.id !== btn.dataset.id);
      saveData();
      renderCaixa();
    });
  });

  renderGraficosCaixa();
  popularSelectOperador();
  renderCaixaPorOperador();
}

// Preenche o select de operador do lançamento manual com os funcionários
// ativos cadastrados no Estoque.
function popularSelectOperador() {
  const select = document.getElementById("cx-operador");
  if (!select) return;
  const atual = select.value;
  select.innerHTML =
    `<option value="">Não atribuído</option>` +
    DATA.funcionarios.filter((f) => f.ativo).map((f) => `<option value="${f.id}">${f.nome}</option>`).join("");
  if (DATA.funcionarios.some((f) => f.id === atual)) select.value = atual;
}

// Resolve o operador responsável por um lançamento de caixa: para entradas
// vindas de pedido, usa o funcionário atualmente atribuído a esse pedido
// (pode ter sido atribuído depois do lançamento); para lançamentos manuais,
// usa o operador escolhido no momento do lançamento.
function getOperadorCash(entry) {
  if (entry.origem === "pedido" && entry.orderId) {
    const order = DATA.orders.find((o) => o.id === entry.orderId);
    if (order && order.funcionarioId) return { id: order.funcionarioId, nome: order.funcionarioNome };
    return { id: "", nome: "Não atribuído" };
  }
  if (entry.operadorId) return { id: entry.operadorId, nome: entry.operadorNome };
  return { id: "", nome: "Não atribuído" };
}

// Agrupa entradas/saídas/saldo por operador, na sub-aba "Por operador" do
// Fluxo de Caixa.
function renderCaixaPorOperador() {
  const container = document.getElementById("caixa-operador-list");
  if (!container) return;

  if (DATA.cash.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum lançamento ainda.</div>`;
    return;
  }

  const grupos = {};
  DATA.cash.forEach((c) => {
    const op = getOperadorCash(c);
    const key = op.id || "sem_operador";
    if (!grupos[key]) grupos[key] = { nome: op.nome, entradas: 0, saidas: 0 };
    if (c.tipo === "entrada") grupos[key].entradas += c.valor;
    else grupos[key].saidas += c.valor;
  });

  const linhas = Object.values(grupos).sort((a, b) => b.entradas - a.entradas);

  container.innerHTML = `<div class="ranking-list">${linhas
    .map(
      (g) => `
    <div class="ranking-row">
      <div class="nome">${g.nome}</div>
      <div class="valor">${fmtMoney(g.entradas - g.saidas)} <span class="sub">(entradas ${fmtMoney(g.entradas)} · saídas ${fmtMoney(g.saidas)})</span></div>
    </div>
  `
    )
    .join("")}</div>`;
}

/* ---------- Gráficos de faturamento (semanal / mensal) ---------- */

// Agrupa as entradas (faturamento) usando porFn para gerar a chave de cada
// período (ex: início da semana, ou ano-mês), e calcula o crescimento (%)
// de cada período em relação ao período imediatamente anterior no histórico
// completo (mesmo que esse período anterior não apareça no recorte final).
function agruparFaturamento(porFn, limite) {
  const entradas = DATA.cash.filter((c) => c.tipo === "entrada");
  const map = {};
  entradas.forEach((c) => {
    const key = porFn(c.date);
    map[key] = (map[key] || 0) + c.valor;
  });

  const chaves = Object.keys(map).sort();
  const resultado = chaves.map((key, idx) => {
    const total = map[key];
    const anterior = idx > 0 ? map[chaves[idx - 1]] : null;
    let crescimento = null;
    if (anterior !== null) {
      crescimento = anterior === 0 ? (total > 0 ? 100 : null) : ((total - anterior) / anterior) * 100;
    }
    return { key, total, crescimento };
  });

  return resultado.slice(-limite);
}

function renderFaturamentoChart(containerId, dados, labelFn) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (dados.length === 0) {
    container.innerHTML = `<div class="empty small">Sem dados de faturamento ainda</div>`;
    return;
  }

  const maior = Math.max(...dados.map((d) => d.total), 0.01);

  container.innerHTML = `
    <div class="faturamento-list">
      ${dados
        .map((d) => {
          const pct = Math.max(4, (d.total / maior) * 100);
          let crescimentoHtml = "";
          if (d.crescimento !== null) {
            const positivo = d.crescimento >= 0;
            crescimentoHtml = `<span class="tag ${positivo ? "up" : "down"}">${positivo ? "▲" : "▼"} ${Math.abs(d.crescimento).toFixed(0)}%</span>`;
          }
          return `
            <div class="faturamento-row">
              <div class="periodo">${labelFn(d.key)}</div>
              <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
              <div class="valores">
                <span class="valor">${fmtMoney(d.total)}</span>
                ${crescimentoHtml}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderGraficosCaixa() {
  if (!document.getElementById("grafico-semanal") && !document.getElementById("grafico-mensal")) return;

  const semanal = agruparFaturamento((date) => weekStartISO(date), 8);
  const mensal = agruparFaturamento((date) => monthKey(date), 6);

  renderFaturamentoChart("grafico-semanal", semanal, (key) => `${fmtDate(key)}–${fmtDate(weekEndISO(key))}`);
  renderFaturamentoChart("grafico-mensal", mensal, monthLabel);
}

function adicionarLancamento() {
  const tipo = document.getElementById("cx-tipo").value;
  const descricao = document.getElementById("cx-descricao").value.trim();
  const valor = Number(document.getElementById("cx-valor").value);
  const date = document.getElementById("cx-data").value || todayISO();
  const operadorSelect = document.getElementById("cx-operador");
  const operador = operadorSelect && operadorSelect.value ? DATA.funcionarios.find((f) => f.id === operadorSelect.value) : null;

  if (!descricao || !valor || valor <= 0) {
    toast("Preencha descrição e um valor válido.");
    return;
  }

  refreshDataFromStorage();
  DATA.cash.unshift({
    id: uid("cx"),
    date,
    tipo,
    origem: "manual",
    descricao,
    valor,
    operadorId: operador ? operador.id : "",
    operadorNome: operador ? operador.nome : "",
  });
  saveData();
  document.getElementById("cx-descricao").value = "";
  document.getElementById("cx-valor").value = "";
  renderCaixa();
  toast("Lançamento adicionado.");
}

/* ===================================================
   PAGINA: COLABORADORES
   =================================================== */

// Tudo relacionado a entrega/motoboy: bairros com taxa fixa, cadastro de
// entregadores e tempo médio de entrega (geral e por entregador).
function renderEntrega() {
  renderBairros();
  renderEntregadores();
  renderTempoEntrega();
}

// Tudo relacionado à equipe (não motoboys): funcionários, escala,
// ponto e usuários do sistema. Chamada tanto ao abrir a aba Colaboradores
// diretamente quanto de dentro de renderEstoque() (que antes renderizava
// isso junto), para não precisar caçar todo call site espalhado pelo arquivo.
function renderColaboradores() {
  renderFuncionarios();
  renderEscala();
  renderRegistroPonto();
  renderUsuarios();
}

/* ===================================================
   PAGINA: ESTOQUE
   =================================================== */

function renderEstoque() {
  atualizarAlertaEstoqueBaixo();
  atualizarBadgePerdas();
  atualizarBadgeCompras();
  renderEntrega();
  renderColaboradores();

  const container = document.getElementById("estoque-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.stock.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum item no estoque</div>`;
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr><th>Item</th><th>Qtd.</th><th>Unid.</th><th>Mínimo</th><th>Custo unit. (R$)</th><th>Status</th><th></th></tr>
    </thead>
    <tbody>
      ${DATA.stock
        .map(
          (s) => `
        <tr>
          <td>${s.nome}</td>
          <td>
            <div class="qty-control" style="justify-content:flex-start">
              <button data-act="menos-estoque" data-id="${s.id}">−</button>
              <span>${s.quantidade}</span>
              <button data-act="mais-estoque" data-id="${s.id}">+</button>
            </div>
          </td>
          <td>${s.unidade}</td>
          <td>${s.minimo}</td>
          <td><input type="number" min="0" step="0.01" class="input-custo" style="width:90px;" data-act="edit-custo" data-id="${s.id}" value="${s.custo}" /></td>
          <td>${s.quantidade <= s.minimo ? `<span class="tag baixo">Estoque baixo</span>` : `<span class="tag entregue">Ok</span>`}</td>
          <td>
            <button class="btn small secondary" data-act="registrar-compra" data-id="${s.id}">Registrar compra</button>
            <button class="btn small secondary" data-act="registrar-perda" data-id="${s.id}">Registrar perda</button>
            <button class="btn small danger" data-act="del-estoque" data-id="${s.id}">Remover</button>
          </td>
        </tr>
      `
        )
        .join("")}
    </tbody>
  `;
  container.appendChild(table);

  container.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = DATA.stock.find((s) => s.id === btn.dataset.id);
      if (!item) return;
      if (btn.dataset.act === "mais-estoque") item.quantidade = Math.round((item.quantidade + 1) * 100) / 100;
      if (btn.dataset.act === "menos-estoque") item.quantidade = Math.max(0, Math.round((item.quantidade - 1) * 100) / 100);
      if (btn.dataset.act === "del-estoque") DATA.stock = DATA.stock.filter((s) => s.id !== item.id);
      if (btn.dataset.act === "registrar-perda") {
        registrarPerdaEstoque(item);
        return;
      }
      if (btn.dataset.act === "registrar-compra") {
        registrarCompraEstoque(item);
        return;
      }
      saveData();
      renderEstoque();
    });
  });

  container.querySelectorAll("input[data-act='edit-custo']").forEach((input) => {
    input.addEventListener("change", () => {
      const item = DATA.stock.find((s) => s.id === input.dataset.id);
      if (!item) return;
      const val = Number(input.value);
      item.custo = isNaN(val) || val < 0 ? 0 : val;
      saveData();
      toast("Custo atualizado.");
    });
  });
}

// Alerta de estoque baixo: mostra um badge na aba "Estoque" (visível em
// qualquer página) e um banner no topo da página de Estoque, listando os
// itens com quantidade menor ou igual ao mínimo cadastrado.
function atualizarAlertaEstoqueBaixo() {
  const baixos = DATA.stock.filter((s) => s.quantidade <= s.minimo);

  const badge = document.getElementById("badge-estoque-baixo");
  if (badge) {
    if (baixos.length > 0) {
      badge.textContent = baixos.length;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  }

  const banner = document.getElementById("alerta-estoque-baixo");
  if (banner) {
    if (baixos.length > 0) {
      const nomes = baixos.map((s) => `${s.nome} (${s.quantidade} ${s.unidade})`).join(", ");
      banner.innerHTML = `<strong>Estoque baixo:</strong> ${nomes}`;
      banner.style.display = "flex";
    } else {
      banner.style.display = "none";
    }
  }
}

function adicionarEstoque() {
  const nome = document.getElementById("es-nome").value.trim();
  const unidade = document.getElementById("es-unidade").value.trim() || "un";
  const quantidade = Number(document.getElementById("es-quantidade").value || 0);
  const minimo = Number(document.getElementById("es-minimo").value || 0);
  const custo = Number(document.getElementById("es-custo")?.value || 0);

  if (!nome) {
    toast("Informe o nome do item.");
    return;
  }

  refreshDataFromStorage();
  DATA.stock.push({ id: uid("st"), nome, unidade, quantidade, minimo, custo: isNaN(custo) ? 0 : custo });
  saveData();
  document.getElementById("es-nome").value = "";
  document.getElementById("es-quantidade").value = "";
  document.getElementById("es-minimo").value = "";
  if (document.getElementById("es-custo")) document.getElementById("es-custo").value = "";
  renderEstoque();
  toast("Item adicionado ao estoque.");
}

// Registra uma perda/desperdício de um item de estoque: pergunta a quantidade
// perdida e o motivo, desconta do estoque (sem deixar negativo) e guarda um
// registro separado do consumo normal por venda (DATA.perdas).
function registrarPerdaEstoque(item) {
  const qtdStr = prompt(`Quantidade perdida de "${item.nome}" (${item.unidade}):`);
  if (qtdStr === null) return;
  const qtd = Number(String(qtdStr).replace(",", "."));
  if (isNaN(qtd) || qtd <= 0) {
    toast("Informe uma quantidade válida.");
    return;
  }

  const motivo = prompt("Motivo da perda/desperdício (ex: validade vencida, queimou na brasa...):");
  if (motivo === null) return;

  refreshDataFromStorage();
  const stockItem = DATA.stock.find((s) => s.id === item.id);
  if (!stockItem) return;

  const qtdDescontada = Math.min(qtd, stockItem.quantidade);
  stockItem.quantidade = Math.max(0, Math.round((stockItem.quantidade - qtd) * 100) / 100);

  DATA.perdas.unshift({
    id: uid("prd"),
    stockId: stockItem.id,
    nome: stockItem.nome,
    unidade: stockItem.unidade,
    quantidade: qtdDescontada,
    motivo: motivo.trim() || "Não informado",
    registradoEm: new Date().toISOString(),
  });

  saveData();
  renderEstoque();
  toast("Perda registrada e descontada do estoque.");
}

// Atualiza o badge de contagem no botão "Perdas / Desperdício" da página de Estoque.
function atualizarBadgePerdas() {
  const badge = document.getElementById("badge-perdas");
  if (!badge) return;
  const total = DATA.perdas.length;
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

function renderPerdas() {
  atualizarBadgePerdas();

  const container = document.getElementById("perdas-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.perdas.length === 0) {
    container.innerHTML = `<div class="empty">Nenhuma perda registrada até agora.</div>`;
    return;
  }

  DATA.perdas.forEach((p) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${p.nome}</span>
        <span class="valor">${p.quantidade} ${p.unidade}</span>
      </div>
      <div class="meta">Registrado em ${fmtDateTime(p.registradoEm)}</div>
      <div class="meta"><strong>Motivo:</strong> ${p.motivo}</div>
    `;
    container.appendChild(div);
  });
}

function openDiaFinalizadoModal() {
  const overlay = document.getElementById("dia-finalizado-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "flex";
}

function closeDiaFinalizadoModal() {
  const overlay = document.getElementById("dia-finalizado-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

function openPerdasModal() {
  const overlay = document.getElementById("perdas-modal-overlay");
  if (!overlay) return;
  renderPerdas();
  overlay.style.display = "flex";
}

function closePerdasModal() {
  const overlay = document.getElementById("perdas-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

// Registra uma compra/reabastecimento de um item de estoque (fornecedor ou
// mercado): pergunta quantidade comprada, fornecedor e custo unitário pago,
// soma a quantidade ao estoque e guarda um histórico separado da venda/perda.
function registrarCompraEstoque(item) {
  const qtdStr = prompt(`Quantidade comprada de "${item.nome}" (${item.unidade}):`);
  if (qtdStr === null) return;
  const qtd = Number(String(qtdStr).replace(",", "."));
  if (isNaN(qtd) || qtd <= 0) {
    toast("Informe uma quantidade válida.");
    return;
  }

  const fornecedor = prompt("Fornecedor (ex: RC Premier, Mercado, Açougue...):");
  if (fornecedor === null) return;

  const custoStr = prompt("Custo unitário pago (R$) — deixe em branco para manter o custo atual:");
  if (custoStr === null) return;

  refreshDataFromStorage();
  const stockItem = DATA.stock.find((s) => s.id === item.id);
  if (!stockItem) return;

  let custoUnitario = stockItem.custo;
  const custoNum = Number(String(custoStr).replace(",", "."));
  if (custoStr.trim() !== "" && !isNaN(custoNum) && custoNum >= 0) {
    custoUnitario = custoNum;
    stockItem.custo = custoNum;
  }

  stockItem.quantidade = Math.round((stockItem.quantidade + qtd) * 100) / 100;

  DATA.compras.unshift({
    id: uid("cmp"),
    stockId: stockItem.id,
    nome: stockItem.nome,
    unidade: stockItem.unidade,
    quantidade: qtd,
    fornecedor: fornecedor.trim() || "Não informado",
    custoUnitario,
    custoTotal: Math.round(custoUnitario * qtd * 100) / 100,
    registradoEm: new Date().toISOString(),
  });

  saveData();
  renderEstoque();
  toast("Compra registrada e adicionada ao estoque.");
}

// Atualiza o badge de contagem no botão "Histórico de compras" da página de Estoque.
function atualizarBadgeCompras() {
  const badge = document.getElementById("badge-compras");
  if (!badge) return;
  const total = DATA.compras.length;
  if (total > 0) {
    badge.textContent = total;
    badge.style.display = "inline-flex";
  } else {
    badge.style.display = "none";
  }
}

function renderCompras() {
  atualizarBadgeCompras();

  const container = document.getElementById("compras-list");
  if (!container) return;
  container.innerHTML = "";

  if (DATA.compras.length === 0) {
    container.innerHTML = `<div class="empty">Nenhuma compra registrada até agora.</div>`;
    return;
  }

  DATA.compras.forEach((c) => {
    const div = document.createElement("div");
    div.className = "pedido-compact-card";
    div.style.marginBottom = "10px";
    div.innerHTML = `
      <div class="row-top">
        <span class="numero">${c.nome}</span>
        <span class="valor">${fmtMoney(c.custoTotal)}</span>
      </div>
      <div class="nome">${c.fornecedor}</div>
      <div class="meta">Registrado em ${fmtDateTime(c.registradoEm)}</div>
      <div class="meta">Quantidade: ${c.quantidade} ${c.unidade} · Custo unit.: ${fmtMoney(c.custoUnitario)}</div>
    `;
    container.appendChild(div);
  });
}

function openComprasModal() {
  const overlay = document.getElementById("compras-modal-overlay");
  if (!overlay) return;
  renderCompras();
  overlay.style.display = "flex";
}

function closeComprasModal() {
  const overlay = document.getElementById("compras-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
}

/* ===================================================
   PAGINA: HISTORICO DE CLIENTES
   =================================================== */

function renderHistorico() {
  const container = document.getElementById("historico-list");
  if (!container) return;
  const busca = (document.getElementById("busca-cliente")?.value || "").toLowerCase();
  const dataInicio = document.getElementById("historico-data-inicio")?.value || "";
  const dataFim = document.getElementById("historico-data-fim")?.value || "";
  container.innerHTML = "";

  // Total histórico (sem filtro de data) — usado para calcular a cortesia, que é acumulada ao longo do tempo
  const totalGeralPorCliente = {};
  DATA.orders.forEach((o) => {
    const key = o.customer.telefone || o.customer.nome;
    totalGeralPorCliente[key] = (totalGeralPorCliente[key] || 0) + o.total;
  });

  // Todos os clientes já vistos (sem filtro de período/busca) — usado para a
  // lista de aniversariantes, que não deve depender do filtro de data.
  const clientesBasicos = {};
  DATA.orders.forEach((o) => {
    const key = o.customer.telefone || o.customer.nome;
    if (!clientesBasicos[key]) clientesBasicos[key] = { nome: o.customer.nome, telefone: o.customer.telefone, ultimoPedido: o.createdAt };
  });
  renderAniversariantes(clientesBasicos);
  renderClientesInativos(clientesBasicos);

  // Pedidos dentro do período selecionado (se nenhuma data for informada, considera todos)
  const pedidosNoPeriodo = DATA.orders.filter((o) => {
    const dataPedido = (o.createdAt || "").slice(0, 10);
    if (dataInicio && dataPedido < dataInicio) return false;
    if (dataFim && dataPedido > dataFim) return false;
    return true;
  });

  const map = {};
  pedidosNoPeriodo.forEach((o) => {
    const key = o.customer.telefone || o.customer.nome;
    if (!map[key]) map[key] = { nome: o.customer.nome, telefone: o.customer.telefone, pedidos: [] };
    map[key].pedidos.push(o);
  });

  const todosClientes = Object.values(map).map((c) => {
    const key = c.telefone || c.nome;
    return {
      ...c,
      totalGasto: c.pedidos.reduce((a, o) => a + o.total, 0),
      totalGastoGeral: totalGeralPorCliente[key] || 0,
    };
  });

  renderRankingClientes(todosClientes);

  let clientes = todosClientes;
  if (busca) {
    clientes = clientes.filter((c) => c.nome.toLowerCase().includes(busca) || c.telefone.includes(busca));
  }
  // Clientes VIP aparecem primeiro; dentro de cada grupo, pedido mais recente primeiro.
  clientes.sort((a, b) => {
    const vipA = isClienteVip(getClienteKey(a)) ? 1 : 0;
    const vipB = isClienteVip(getClienteKey(b)) ? 1 : 0;
    if (vipA !== vipB) return vipB - vipA;
    return new Date(b.pedidos[0].createdAt) - new Date(a.pedidos[0].createdAt);
  });

  if (clientes.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum cliente encontrado${dataInicio || dataFim ? " no período selecionado" : ""}</div>`;
    return;
  }

  const periodoAtivo = !!(dataInicio || dataFim);

  clientes.forEach((c) => {
    const key = getClienteKey(c);
    container.appendChild(buildClienteCompactCard(c, key, periodoAtivo));
  });

  container.querySelectorAll("button[data-act='ver-cliente']").forEach((btn) => {
    btn.addEventListener("click", () => openClienteModal(btn.dataset.key));
  });

  // Se o modal de detalhe de um cliente estiver aberto, atualiza o conteúdo
  // com os dados mais recentes (ex.: depois de marcar VIP, resgatar cashback
  // ou uma sincronização entre abas).
  const clienteModalOverlay = document.getElementById("cliente-modal-overlay");
  if (clienteModalOverlay && clienteModalOverlay.style.display === "flex" && clienteModalOverlay.dataset.clienteKey) {
    renderClienteModalContent(clienteModalOverlay.dataset.clienteKey);
  }
}

// Card compacto de cliente na lista "Todos os clientes" — mostra só o
// essencial (nome, telefone, total, nº de pedidos e tags rápidas). O
// detalhe completo (histórico de pedidos, cortesia, cashback, aniversário)
// fica no modal, aberto pelo botão "Ver pedidos".
function buildClienteCompactCard(c, key, periodoAtivo) {
  const totalGastoGeral = c.totalGastoGeral;
  const cortesiasGanhas = Math.floor(totalGastoGeral / COURTESY_THRESHOLD);
  const vip = isClienteVip(key);
  const ultimoPedidoGeral = c.pedidos[0].createdAt;
  const inativo = isClienteInativo(ultimoPedidoGeral);

  const div = document.createElement("div");
  div.className = "pedido-compact-card";
  div.innerHTML = `
    <div class="row-top">
      <span class="numero">${c.telefone}</span>
      <span class="valor">${fmtMoney(c.totalGasto)}</span>
    </div>
    <div class="nome">${c.nome}</div>
    <div class="meta">${c.pedidos.length} pedido(s)${periodoAtivo ? " no período" : ""} · Último pedido: ${fmtDateTime(ultimoPedidoGeral)}</div>
    ${
      vip || cortesiasGanhas > 0 || inativo
        ? `<div class="tags-row">
      ${vip ? `<span class="tag vip">★ VIP</span>` : ""}
      ${cortesiasGanhas > 0 ? `<span class="tag cortesia">${cortesiasGanhas > 1 ? cortesiasGanhas + "x " : ""}Cortesia disponível</span>` : ""}
      ${inativo ? `<span class="tag inativo">Inativo</span>` : ""}
    </div>`
        : ""
    }
    <button class="btn small secondary" data-act="ver-cliente" data-key="${key}">Ver pedidos</button>
  `;
  return div;
}

// Conteúdo completo do modal de detalhe do cliente: tags, cortesia, cashback,
// aniversário e histórico de pedidos — o que antes ficava direto na lista.
function renderClienteModalContent(key) {
  const content = document.getElementById("cliente-modal-content");
  if (!content) return;

  const dataInicio = document.getElementById("historico-data-inicio")?.value || "";
  const dataFim = document.getElementById("historico-data-fim")?.value || "";
  const periodoAtivo = !!(dataInicio || dataFim);

  // DATA.orders vem do mais recente para o mais antigo (unshift ao criar pedido).
  const pedidosDoCliente = DATA.orders.filter((o) => (o.customer.telefone || o.customer.nome) === key);
  if (pedidosDoCliente.length === 0) {
    content.innerHTML = `<div class="empty">Cliente não encontrado.</div>`;
    return;
  }

  const pedidosNoPeriodo = pedidosDoCliente.filter((o) => {
    const dataPedido = (o.createdAt || "").slice(0, 10);
    if (dataInicio && dataPedido < dataInicio) return false;
    if (dataFim && dataPedido > dataFim) return false;
    return true;
  });
  const pedidosExibidos = periodoAtivo ? pedidosNoPeriodo : pedidosDoCliente;

  const nome = pedidosDoCliente[0].customer.nome;
  const telefone = pedidosDoCliente[0].customer.telefone;
  const totalGastoGeral = pedidosDoCliente.reduce((a, o) => a + o.total, 0);
  const totalGasto = pedidosExibidos.reduce((a, o) => a + o.total, 0);

  const cortesiasGanhas = Math.floor(totalGastoGeral / COURTESY_THRESHOLD);
  const restoNoCiclo = totalGastoGeral % COURTESY_THRESHOLD;
  const faltaProxima = COURTESY_THRESHOLD - restoNoCiclo;
  const progresso = (restoNoCiclo / COURTESY_THRESHOLD) * 100;

  const vip = isClienteVip(key);
  const pontos = calcularPontosCliente(totalGastoGeral);
  const saldoCashback = calcularSaldoCashback(totalGastoGeral, key);
  const aniversario = getAniversarioCliente(key);
  const ultimoPedidoGeral = pedidosDoCliente[0].createdAt;
  const diasInativo = calcularDiasInativo(ultimoPedidoGeral);
  const inativo = isClienteInativo(ultimoPedidoGeral);

  content.innerHTML = `
    <div class="name">${nome} <span class="sub">— ${telefone}</span>
      ${vip ? `<span class="tag vip">★ VIP</span>` : ""}
      ${cortesiasGanhas > 0 ? `<span class="tag cortesia">${cortesiasGanhas > 1 ? cortesiasGanhas + "x " : ""}Cortesia disponível</span>` : ""}
      <span class="tag pontos">${pontos} pts</span>
      ${saldoCashback > 0 ? `<span class="tag cashback">Cashback: ${fmtMoney(saldoCashback)}</span>` : ""}
      ${aniversario ? `<span class="tag aniversario">🎂 ${fmtAniversario(aniversario)}</span>` : ""}
      ${inativo ? `<span class="tag inativo">Inativo (${diasInativo}d)</span>` : ""}
    </div>
    <div class="sub" style="margin-top:6px;">${pedidosExibidos.length} pedido(s)${periodoAtivo ? " no período" : ""} · Total${periodoAtivo ? " no período" : " gasto"}: ${fmtMoney(totalGasto)}${periodoAtivo ? ` · Total geral: ${fmtMoney(totalGastoGeral)}` : ""} · Último pedido: ${fmtDateTime(ultimoPedidoGeral)}</div>
    <div class="courtesy-progress">
      <div class="track"><div class="fill" style="width:${progresso.toFixed(0)}%;"></div></div>
      <div class="label">Faltam ${fmtMoney(faltaProxima)} em pedidos para a próxima cortesia (a cada ${fmtMoney(COURTESY_THRESHOLD)} em compras)</div>
    </div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:14px 0;">
      <button class="btn small secondary btn-toggle-vip">${vip ? "Remover VIP" : "Marcar VIP"}</button>
      ${saldoCashback > 0 ? `<button class="btn small secondary btn-resgatar-cashback">Resgatar cashback</button>` : ""}
      <button class="btn small secondary btn-definir-aniversario">${aniversario ? "Editar aniversário" : "Definir aniversário"}</button>
    </div>
    <div class="section-title" style="margin:12px 0 6px 0;">Histórico${periodoAtivo ? " (período selecionado)" : ""}</div>
    ${
      pedidosExibidos.length === 0
        ? `<div class="empty">Nenhum pedido no período selecionado.</div>`
        : pedidosExibidos
            .map(
              (o) => `
      <div style="font-size:13px; padding:6px 0; border-bottom:1px dotted #e5e5e5;">
        ${fmtDateTime(o.createdAt)} — ${o.items.map((i) => i.qtd + "x " + i.nome).join(", ")} — <strong>${fmtMoney(o.total)}</strong>
        <span class="tag ${o.status}" style="margin-left:6px;">${STATUS_LABEL[o.status]}</span>
      </div>
    `
            )
            .join("")
    }
  `;

  const btnVip = content.querySelector(".btn-toggle-vip");
  if (btnVip) btnVip.addEventListener("click", () => toggleClienteVip(key));
  const btnCashback = content.querySelector(".btn-resgatar-cashback");
  if (btnCashback) btnCashback.addEventListener("click", () => resgatarCashback(key, nome, saldoCashback));
  const btnAniversario = content.querySelector(".btn-definir-aniversario");
  if (btnAniversario) btnAniversario.addEventListener("click", () => definirAniversarioCliente(key, nome));
}

function openClienteModal(key) {
  const overlay = document.getElementById("cliente-modal-overlay");
  if (!overlay) return;
  overlay.dataset.clienteKey = key;
  renderClienteModalContent(key);
  overlay.style.display = "flex";
}

function closeClienteModal() {
  const overlay = document.getElementById("cliente-modal-overlay");
  if (!overlay) return;
  overlay.style.display = "none";
  overlay.dataset.clienteKey = "";
}

function renderRankingClientes(clientes) {
  const container = document.getElementById("ranking-clientes");
  if (!container) return;

  const ranking = [...clientes].filter((c) => c.totalGasto > 0).sort((a, b) => b.totalGasto - a.totalGasto).slice(0, 10);

  if (ranking.length === 0) {
    container.innerHTML = `<div class="empty">Sem dados suficientes para o ranking neste período</div>`;
    return;
  }

  const maior = ranking[0].totalGasto;

  container.innerHTML = `
    <div class="ranking-list">
      ${ranking
        .map((c, i) => {
          const pct = maior > 0 ? Math.max(4, (c.totalGasto / maior) * 100) : 0;
          const cortesias = Math.floor((c.totalGastoGeral ?? c.totalGasto) / COURTESY_THRESHOLD);
          const vip = isClienteVip(getClienteKey(c));
          const pontos = calcularPontosCliente(c.totalGastoGeral ?? c.totalGasto);
          return `
        <div class="ranking-row ranking-row-bar">
          <div class="pos">${i + 1}º</div>
          <div class="nome" title="${c.nome}">${c.nome}${vip ? ` <span class="tag vip" style="margin-left:4px;">★ VIP</span>` : ""}${cortesias > 0 ? ` <span class="tag cortesia" style="margin-left:4px;">${cortesias > 1 ? cortesias + "x " : ""}Cortesia</span>` : ""} <span class="tag pontos" style="margin-left:4px;">${pontos} pts</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
          <div class="valor">${fmtMoney(c.totalGasto)}</div>
        </div>
      `;
        })
        .join("")}
    </div>
  `;
}

/* ===================================================
   PAGINA: RELATORIOS
   =================================================== */

// Soma a quantidade vendida e o faturamento de cada item do cardápio, somando
// os itens de todos os pedidos válidos (pedidos cancelados já saem de
// DATA.orders, então não entram aqui). Inclui itens com 0 vendas para que
// apareçam no relatório de "menos vendidos".
function calcularVendasPorProduto() {
  const porProduto = {};
  DATA.menu.forEach((m) => {
    porProduto[m.id] = { menuId: m.id, nome: m.nome, categoria: m.categoria, qtdVendida: 0, faturamento: 0 };
  });
  DATA.orders.forEach((o) => {
    o.items.forEach((item) => {
      if (!porProduto[item.menuId]) return;
      porProduto[item.menuId].qtdVendida += item.qtd;
      porProduto[item.menuId].faturamento += item.qtd * item.preco;
    });
  });
  return Object.values(porProduto);
}

// Agrupa os pedidos por hora do dia (0-23) usando createdAt, contando quantos
// pedidos e somando o faturamento de cada hora.
function calcularMovimentoPorHora() {
  const porHora = [];
  for (let h = 0; h < 24; h++) {
    porHora.push({ hora: h, qtdPedidos: 0, faturamento: 0 });
  }
  DATA.orders.forEach((o) => {
    if (!o.createdAt) return;
    const hora = new Date(o.createdAt).getHours();
    if (Number.isNaN(hora) || !porHora[hora]) return;
    porHora[hora].qtdPedidos += 1;
    porHora[hora].faturamento += o.total || 0;
  });
  return porHora;
}

// Nomes dos dias da semana na ordem retornada por Date.getDay() (0 = domingo).
const DIAS_SEMANA_LABELS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// Agrupa os pedidos por dia da semana (0 = domingo .. 6 = sábado) usando
// createdAt, contando pedidos e somando o faturamento de cada dia.
function calcularFaturamentoPorDiaSemana() {
  const porDia = DIAS_SEMANA_LABELS.map((label, idx) => ({ diaSemana: idx, label, qtdPedidos: 0, faturamento: 0 }));
  DATA.orders.forEach((o) => {
    if (!o.createdAt) return;
    const dia = new Date(o.createdAt).getDay();
    if (Number.isNaN(dia) || !porDia[dia]) return;
    porDia[dia].qtdPedidos += 1;
    porDia[dia].faturamento += o.total || 0;
  });
  return porDia;
}

// Calcula, para cada item do cardápio, o preço de venda, o custo unitário
// (via custoUnitarioMenu, que usa a receita/MENU_RECIPE) e a margem de lucro
// em R$ e em % sobre o preço de venda.
function calcularMargemPorProduto() {
  return DATA.menu.map((m) => {
    const custoUnit = custoUnitarioMenu(m.id);
    const margemReais = m.preco - custoUnit;
    const margemPercent = m.preco > 0 ? (margemReais / m.preco) * 100 : 0;
    return { menuId: m.id, nome: m.nome, categoria: m.categoria, preco: m.preco, custoUnit, margemReais, margemPercent };
  });
}

// Soma, por categoria do cardápio, o faturamento e o lucro real das vendas
// já realizadas (itens dos pedidos em DATA.orders), usando o custo unitário
// de cada produto (custoUnitarioMenu) para calcular o lucro item a item.
function calcularLucroPorCategoria() {
  const porCategoria = {};
  DATA.menu.forEach((m) => {
    if (!porCategoria[m.categoria]) {
      porCategoria[m.categoria] = { categoria: m.categoria, qtdVendida: 0, faturamento: 0, lucro: 0 };
    }
  });
  DATA.orders.forEach((o) => {
    o.items.forEach((item) => {
      const menuItem = DATA.menu.find((m) => m.id === item.menuId);
      if (!menuItem) return;
      if (!porCategoria[menuItem.categoria]) {
        porCategoria[menuItem.categoria] = { categoria: menuItem.categoria, qtdVendida: 0, faturamento: 0, lucro: 0 };
      }
      const custoUnit = custoUnitarioMenu(item.menuId);
      porCategoria[menuItem.categoria].qtdVendida += item.qtd;
      porCategoria[menuItem.categoria].faturamento += item.qtd * item.preco;
      porCategoria[menuItem.categoria].lucro += (item.preco - custoUnit) * item.qtd;
    });
  });
  return Object.values(porCategoria);
}

// Curva ABC: classifica os produtos pelo faturamento acumulado.
// Classe A = produtos que juntos somam até 80% do faturamento total.
// Classe B = de 80% até 95%. Classe C = de 95% até 100% (o restante).
// Produtos sem nenhuma venda entram como classe C.
function calcularCurvaABC() {
  const vendas = calcularVendasPorProduto();
  const faturamentoTotal = vendas.reduce((acc, p) => acc + p.faturamento, 0);
  const ordenadas = [...vendas].sort((a, b) => b.faturamento - a.faturamento);

  let acumulado = 0;
  return ordenadas.map((p) => {
    acumulado += p.faturamento;
    const percentAcumulado = faturamentoTotal > 0 ? (acumulado / faturamentoTotal) * 100 : 0;
    let classe = "C";
    if (faturamentoTotal > 0 && p.faturamento > 0) {
      if (percentAcumulado <= 80) classe = "A";
      else if (percentAcumulado <= 95) classe = "B";
      else classe = "C";
    }
    return { ...p, percentAcumulado, classe };
  });
}

// Rótulos legíveis para cada forma de pagamento usada em o.customer.pagamento.
const FORMAS_PAGAMENTO_LABEL = { dinheiro: "Dinheiro", pix: "Pix", cartao: "Cartão" };

// Soma a quantidade de pedidos e o faturamento por forma de pagamento
// (dinheiro / pix / cartão). Pedidos sem forma de pagamento reconhecida
// entram em "Outro", para não serem perdidos silenciosamente do relatório.
function calcularVendasPorFormaPagamento() {
  const porForma = {};
  Object.keys(FORMAS_PAGAMENTO_LABEL).forEach((key) => {
    porForma[key] = { forma: key, label: FORMAS_PAGAMENTO_LABEL[key], qtdPedidos: 0, faturamento: 0 };
  });
  DATA.orders.forEach((o) => {
    const forma = o.customer && FORMAS_PAGAMENTO_LABEL[o.customer.pagamento] ? o.customer.pagamento : "outro";
    if (!porForma[forma]) {
      porForma[forma] = { forma, label: "Outro", qtdPedidos: 0, faturamento: 0 };
    }
    porForma[forma].qtdPedidos += 1;
    porForma[forma].faturamento += o.total || 0;
  });
  return Object.values(porForma);
}

// Relatórios da página Relatórios.
function renderRelatorios() {
  renderRelatorioProdutos();
  renderRelatorioHorarioMovimento();
  renderRelatorioDiaSemana();
  renderRelatorioMargemProduto();
  renderRelatorioLucroCategoria();
  renderRelatorioCurvaABC();
  renderRelatorioFormaPagamento();
}

function renderRelatorioFormaPagamento() {
  const container = document.getElementById("relatorio-forma-pagamento");
  if (!container) return;

  const formas = calcularVendasPorFormaPagamento();
  const comPedidos = formas.filter((f) => f.qtdPedidos > 0);
  if (comPedidos.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum pedido registrado ainda.</div>`;
    return;
  }

  const ordenadas = [...comPedidos].sort((a, b) => b.faturamento - a.faturamento);

  container.innerHTML = `
    <div class="ranking-list">
      ${ordenadas
        .map(
          (f) => `
        <div class="ranking-row">
          <div class="nome">${f.label}</div>
          <div class="valor">${fmtMoney(f.faturamento)} <span class="sub">· ${f.qtdPedidos} pedido(s)</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderRelatorioCurvaABC() {
  const container = document.getElementById("relatorio-curva-abc");
  if (!container) return;

  const abc = calcularCurvaABC();
  if (abc.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum produto cadastrado.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="ranking-list">
      ${abc
        .map(
          (p) => `
        <div class="ranking-row">
          <div class="nome">${p.nome} <span class="sub">(${p.categoria})</span></div>
          <div class="valor">Classe ${p.classe} <span class="sub">· ${fmtMoney(p.faturamento)} · ${p.percentAcumulado.toFixed(0)}% acumulado</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderRelatorioLucroCategoria() {
  const container = document.getElementById("relatorio-lucro-categoria");
  if (!container) return;

  const categorias = calcularLucroPorCategoria();
  if (categorias.length === 0) {
    container.innerHTML = `<div class="empty">Nenhuma categoria cadastrada.</div>`;
    return;
  }

  const ordenadas = [...categorias].sort((a, b) => b.lucro - a.lucro);

  container.innerHTML = `
    <div class="ranking-list">
      ${ordenadas
        .map(
          (c) => `
        <div class="ranking-row">
          <div class="nome">${c.categoria}</div>
          <div class="valor">${fmtMoney(c.lucro)} de lucro <span class="sub">· ${c.qtdVendida} un. vendida(s) · faturamento ${fmtMoney(c.faturamento)}</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderRelatorioMargemProduto() {
  const container = document.getElementById("relatorio-margem-produto");
  if (!container) return;

  const margens = calcularMargemPorProduto();
  if (margens.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum produto cadastrado.</div>`;
    return;
  }

  const ordenadas = [...margens].sort((a, b) => b.margemPercent - a.margemPercent);

  container.innerHTML = `
    <div class="ranking-list">
      ${ordenadas
        .map(
          (p) => `
        <div class="ranking-row">
          <div class="nome">${p.nome} <span class="sub">(${p.categoria})</span></div>
          <div class="valor">${p.margemPercent.toFixed(0)}% <span class="sub">· ${fmtMoney(p.margemReais)} de margem · venda ${fmtMoney(p.preco)}, custo ${fmtMoney(p.custoUnit)}</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderRelatorioDiaSemana() {
  const container = document.getElementById("relatorio-dia-semana");
  if (!container) return;

  const porDia = calcularFaturamentoPorDiaSemana();
  const comPedidos = porDia.filter((d) => d.qtdPedidos > 0);
  if (comPedidos.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum pedido registrado ainda.</div>`;
    return;
  }

  const maisLucrativos = [...comPedidos].sort((a, b) => b.faturamento - a.faturamento);

  container.innerHTML = `
    <div class="ranking-list">
      ${maisLucrativos
        .map(
          (d) => `
        <div class="ranking-row">
          <div class="nome">${d.label}</div>
          <div class="valor">${fmtMoney(d.faturamento)} <span class="sub">· ${d.qtdPedidos} pedido(s)</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderRelatorioHorarioMovimento() {
  const container = document.getElementById("relatorio-horario-movimento");
  if (!container) return;

  const porHora = calcularMovimentoPorHora();
  const comPedidos = porHora.filter((h) => h.qtdPedidos > 0);
  if (comPedidos.length === 0) {
    container.innerHTML = `<div class="empty">Nenhum pedido registrado ainda.</div>`;
    return;
  }

  const maisMovimentados = [...comPedidos].sort((a, b) => b.qtdPedidos - a.qtdPedidos).slice(0, 5);

  const fmtHora = (h) => `${String(h).padStart(2, "0")}h–${String((h + 1) % 24).padStart(2, "0")}h`;

  container.innerHTML = `
    <div class="ranking-list">
      ${maisMovimentados
        .map(
          (h) => `
        <div class="ranking-row">
          <div class="nome">${fmtHora(h.hora)}</div>
          <div class="valor">${h.qtdPedidos} pedido(s) <span class="sub">· ${fmtMoney(h.faturamento)}</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderRelatorioProdutos() {
  const maisContainer = document.getElementById("relatorio-mais-vendidos");
  const menosContainer = document.getElementById("relatorio-menos-vendidos");
  if (!maisContainer && !menosContainer) return;

  const vendas = calcularVendasPorProduto();
  if (vendas.length === 0) {
    if (maisContainer) maisContainer.innerHTML = `<div class="empty">Nenhum produto cadastrado.</div>`;
    if (menosContainer) menosContainer.innerHTML = `<div class="empty">Nenhum produto cadastrado.</div>`;
    return;
  }

  const rankingHtml = (lista) => `
    <div class="ranking-list">
      ${lista
        .map(
          (p) => `
        <div class="ranking-row">
          <div class="nome">${p.nome} <span class="sub">(${p.categoria})</span></div>
          <div class="valor">${p.qtdVendida} un. <span class="sub">· ${fmtMoney(p.faturamento)}</span></div>
        </div>
      `
        )
        .join("")}
    </div>
  `;

  if (maisContainer) {
    const maisVendidos = [...vendas].sort((a, b) => b.qtdVendida - a.qtdVendida).slice(0, 5);
    maisContainer.innerHTML = rankingHtml(maisVendidos);
  }

  if (menosContainer) {
    const menosVendidos = [...vendas].sort((a, b) => a.qtdVendida - b.qtdVendida).slice(0, 5);
    menosContainer.innerHTML = rankingHtml(menosVendidos);
  }
}

/* ===================================================
   INIT
   =================================================== */

document.addEventListener("DOMContentLoaded", () => {
  initNav();

  // Cardápio / Pedido (cardapio.html - cliente, e painel de balcão no index.html)
  if (document.getElementById("f-tipo-entrega")) {
    document.getElementById("f-tipo-entrega").addEventListener("change", toggleEntregaFields);
    document.getElementById("f-pagamento").addEventListener("change", togglePagamentoFields);
    if (document.getElementById("f-taxa-entrega")) {
      document.getElementById("f-taxa-entrega").addEventListener("input", renderCart);
    }
    document.getElementById("btn-enviar-pedido").addEventListener("click", enviarPedido);
    togglePagamentoFields();
    toggleEntregaFields();
    popularSelectBairros();
  }

  // Acompanhamento em tempo real do pedido (cardapio.html - cliente)
  if (document.getElementById("acompanhar-pedido")) {
    document.getElementById("btn-novo-pedido").addEventListener("click", esconderAcompanhamentoPedido);
    setInterval(() => {
      if (ACOMPANHAR_PEDIDO_ID) renderAcompanhamentoPedido();
    }, 4000);
  }

  // Pedidos (index.html - dono)
  if (document.getElementById("filtro-status")) {
    document.getElementById("filtro-status").addEventListener("change", renderPedidos);
  }
  if (document.getElementById("filtro-data-pedidos")) {
    document.getElementById("filtro-data-pedidos").value = todayISO();
    document.getElementById("filtro-data-pedidos").addEventListener("change", renderPedidos);
  }
  if (document.getElementById("filtro-todos-dias")) {
    document.getElementById("filtro-todos-dias").addEventListener("change", () => {
      const dataInput = document.getElementById("filtro-data-pedidos");
      if (dataInput) dataInput.disabled = document.getElementById("filtro-todos-dias").checked;
      renderPedidos();
    });
  }

  // Modal de detalhe do pedido (index.html - dono)
  if (document.getElementById("pedido-modal-overlay")) {
    document.getElementById("pedido-modal-close").addEventListener("click", closePedidoModal);
    document.getElementById("pedido-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "pedido-modal-overlay") closePedidoModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePedidoModal();
    });
  }

  // Modal de histórico de cancelamentos (index.html - dono)
  if (document.getElementById("cancelamentos-modal-overlay")) {
    document.getElementById("btn-cancelamentos").addEventListener("click", openCancelamentosModal);
    document.getElementById("cancelamentos-modal-close").addEventListener("click", closeCancelamentosModal);
    document.getElementById("cancelamentos-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "cancelamentos-modal-overlay") closeCancelamentosModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeCancelamentosModal();
    });
  }

  // Modal de histórico de entregas (index.html - dono)
  if (document.getElementById("entregas-modal-overlay")) {
    document.getElementById("btn-entregas").addEventListener("click", openEntregasModal);
    document.getElementById("entregas-modal-close").addEventListener("click", closeEntregasModal);
    document.getElementById("entregas-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "entregas-modal-overlay") closeEntregasModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeEntregasModal();
    });
  }

  // Modal de detalhe do cliente (index.html - dono)
  if (document.getElementById("cliente-modal-overlay")) {
    document.getElementById("cliente-modal-close").addEventListener("click", closeClienteModal);
    document.getElementById("cliente-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "cliente-modal-overlay") closeClienteModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeClienteModal();
    });
  }

  // Painel de pedido manual (Balcão/Mesa) - index.html
  if (document.getElementById("btn-toggle-balcao")) {
    document.getElementById("btn-toggle-balcao").addEventListener("click", () => {
      const panel = document.getElementById("balcao-panel");
      const btn = document.getElementById("btn-toggle-balcao");
      if (!panel) return;
      const isHidden = panel.style.display === "none" || !panel.style.display;
      panel.style.display = isHidden ? "block" : "none";
      btn.textContent = isHidden ? "Fechar painel de pedido" : "+ Novo pedido (Balcão/Mesa)";
      if (isHidden) renderCardapio();
    });
  }

  // Fluxo de Caixa (index.html - dono)
  if (document.getElementById("btn-add-lancamento")) {
    document.getElementById("btn-add-lancamento").addEventListener("click", adicionarLancamento);
    document.getElementById("cx-data").value = todayISO();
  }

  // Sub-abas do Fluxo de Caixa: Lançamentos / Gráficos
  if (document.querySelector(".subtabs")) {
    document.querySelectorAll(".subtabs button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".subtabs button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.querySelectorAll(".subpage").forEach((p) => p.classList.remove("active"));
        const panel = document.getElementById("caixa-view-" + btn.dataset.subpage);
        if (panel) panel.classList.add("active");
        if (btn.dataset.subpage === "graficos") renderGraficosCaixa();
        if (btn.dataset.subpage === "operador") renderCaixaPorOperador();
      });
    });
  }

  // Estoque (index.html - dono)
  if (document.getElementById("btn-add-estoque")) {
    document.getElementById("btn-add-estoque").addEventListener("click", adicionarEstoque);
  }

  // Bairros de entrega (index.html - dono)
  if (document.getElementById("btn-add-bairro")) {
    document.getElementById("btn-add-bairro").addEventListener("click", () => {
      const nome = document.getElementById("brr-nome").value.trim();
      const taxa = document.getElementById("brr-taxa").value;
      if (!nome) { toast("Informe o nome do bairro."); return; }
      adicionarBairro(nome, taxa);
      document.getElementById("brr-nome").value = "";
      document.getElementById("brr-taxa").value = "";
    });
  }

  // Entregadores (index.html - dono)
  if (document.getElementById("btn-add-entregador")) {
    document.getElementById("btn-add-entregador").addEventListener("click", () => {
      const nome = document.getElementById("ent-nome").value.trim();
      const telefone = document.getElementById("ent-telefone").value.trim();
      if (!nome) { toast("Informe o nome do entregador."); return; }
      adicionarEntregador(nome, telefone);
      document.getElementById("ent-nome").value = "";
      document.getElementById("ent-telefone").value = "";
    });
  }

  if (document.getElementById("btn-add-funcionario")) {
    document.getElementById("btn-add-funcionario").addEventListener("click", () => {
      const nome = document.getElementById("func-nome").value.trim();
      const cargo = document.getElementById("func-cargo").value.trim();
      const telefone = document.getElementById("func-telefone").value.trim();
      if (!nome) { toast("Informe o nome do funcionário."); return; }
      adicionarFuncionario(nome, cargo, telefone);
      document.getElementById("func-nome").value = "";
      document.getElementById("func-cargo").value = "";
      document.getElementById("func-telefone").value = "";
    });
  }

  // Modal de histórico de perdas/desperdício (index.html - dono)
  if (document.getElementById("perdas-modal-overlay")) {
    document.getElementById("btn-perdas").addEventListener("click", openPerdasModal);
    document.getElementById("perdas-modal-close").addEventListener("click", closePerdasModal);
    document.getElementById("perdas-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "perdas-modal-overlay") closePerdasModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePerdasModal();
    });
  }

  // Modal de histórico de compras (index.html - dono)
  if (document.getElementById("compras-modal-overlay")) {
    document.getElementById("btn-compras").addEventListener("click", openComprasModal);
    document.getElementById("compras-modal-close").addEventListener("click", closeComprasModal);
    document.getElementById("compras-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "compras-modal-overlay") closeComprasModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeComprasModal();
    });
  }

  // Histórico de Clientes (index.html - dono)
  if (document.getElementById("busca-cliente")) {
    document.getElementById("busca-cliente").addEventListener("input", renderHistorico);
  }
  if (document.getElementById("historico-data-inicio")) {
    document.getElementById("historico-data-inicio").addEventListener("change", renderHistorico);
    document.getElementById("historico-data-fim").addEventListener("change", renderHistorico);
  }
  if (document.getElementById("btn-limpar-filtro-data")) {
    document.getElementById("btn-limpar-filtro-data").addEventListener("click", () => {
      document.getElementById("historico-data-inicio").value = "";
      document.getElementById("historico-data-fim").value = "";
      renderHistorico();
    });
  }

  // Login e permissões por usuário (index.html - dono)
  if (document.getElementById("login-overlay")) {
    document.getElementById("btn-login").addEventListener("click", fazerLogin);
    document.getElementById("login-pin").addEventListener("keydown", (e) => {
      if (e.key === "Enter") fazerLogin();
    });
  }
  if (document.getElementById("btn-logout")) {
    document.getElementById("btn-logout").addEventListener("click", fazerLogout);
  }
  if (document.getElementById("btn-dia-finalizado")) {
    document.getElementById("btn-dia-finalizado").addEventListener("click", openDiaFinalizadoModal);
  }
  if (document.getElementById("dia-finalizado-modal-overlay")) {
    document.getElementById("btn-dia-finalizado-voltar").addEventListener("click", closeDiaFinalizadoModal);
    document.getElementById("btn-dia-finalizado-confirmar").addEventListener("click", () => {
      finalizarDia();
      closeDiaFinalizadoModal();
    });
    document.getElementById("dia-finalizado-modal-overlay").addEventListener("click", (e) => {
      if (e.target.id === "dia-finalizado-modal-overlay") closeDiaFinalizadoModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDiaFinalizadoModal();
    });
  }
  if (document.getElementById("btn-add-usuario")) {
    document.getElementById("btn-add-usuario").addEventListener("click", () => {
      const nome = document.getElementById("usr-nome").value.trim();
      const papel = document.getElementById("usr-papel").value;
      const pin = document.getElementById("usr-pin").value.trim();
      const funcionarioEl = document.getElementById("usr-funcionario");
      const funcionarioId = funcionarioEl ? funcionarioEl.value : "";
      if (!nome) { toast("Informe o nome do usuário."); return; }
      if (!pin) { toast("Informe o PIN do usuário."); return; }
      adicionarUsuario(nome, papel, pin, funcionarioId);
      document.getElementById("usr-nome").value = "";
      document.getElementById("usr-pin").value = "";
      if (funcionarioEl) funcionarioEl.value = "";
    });
  }
  if (document.getElementById("usr-papel")) {
    const campoUsrFuncionario = document.getElementById("campo-usr-funcionario");
    const atualizarCampoUsrFuncionario = () => {
      if (!campoUsrFuncionario) return;
      campoUsrFuncionario.style.display = document.getElementById("usr-papel").value === "funcionario" ? "" : "none";
    };
    document.getElementById("usr-papel").addEventListener("change", atualizarCampoUsrFuncionario);
    atualizarCampoUsrFuncionario();
  }

  renderAll();

  // Ativa a primeira aba disponível neste arquivo (se houver abas)
  const firstTab = document.querySelector("nav.tabs button");
  if (firstTab) showPage(firstTab.dataset.page);

  // Aplica a tela de login/permissões por cima do painel (index.html - dono)
  aplicarPermissoes();
});
