const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIGURAÇÕES ====================
const EDUSP_API_BASE = 'https://edusp-api.ip.tv'; // API real da Edusp
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL = 'openai/gpt-oss-120b:free';

// Chave fixa para o primeiro endpoint (credenciais)
const CREDENTIALS_SUBSCRIPTION_KEY = '2b03c1db3884488795f79c37c069381a';

// ==================== FUNÇÃO PROXY ====================
async function proxyRequest(req, res, endpoint, method = req.method) {
  const url = `${EDUSP_API_BASE}${endpoint}`;
  
  const headers = {
    ...req.headers,
    host: new URL(EDUSP_API_BASE).host,
  };
  delete headers['content-length'];
  delete headers['connection'];
  delete headers['accept-encoding'];

  const options = {
    method,
    headers,
  };

  if (method !== 'GET' && method !== 'HEAD' && req.body) {
    options.body = JSON.stringify(req.body);
    if (!headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
  }

  try {
    const response = await fetch(url, options);
    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }
    console.log(`[PROXY] ${method} ${endpoint} -> status ${response.status}`);
    res.status(response.status).send(data);
  } catch (error) {
    console.error(`[PROXY] Erro em ${endpoint}:`, error.message);
    res.status(500).json({ error: 'Erro ao comunicar com servidor remoto', details: error.message });
  }
}

// ==================== ROTA DE LOGIN (DUAS ETAPAS) ====================
app.post('/registration/edusp', async (req, res) => {
  const { id, password } = req.body;
  console.log('📥 Requisição de login recebida:', { id, password: '***' });

  if (!id || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
  }

  try {
    // 1ª etapa: obter token do serviço de credenciais
    console.log('🔑 Obtendo token do serviço de credenciais...');
    const credenciaisResponse = await fetch('https://sedintegracoes.educacao.sp.gov.br/credenciais/api/LoginCompletoToken', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': CREDENTIALS_SUBSCRIPTION_KEY,
        'Origin': 'https://saladofuturo.educacao.sp.gov.br',
        'Referer': 'https://saladofuturo.educacao.sp.gov.br/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({ user: id, senha: password })
    });

    if (!credenciaisResponse.ok) {
      const errorText = await credenciaisResponse.text();
      console.error('❌ Erro na 1ª etapa:', credenciaisResponse.status, errorText);
      return res.status(401).json({ error: 'Falha na autenticação com credenciais' });
    }

    const credenciaisData = await credenciaisResponse.json();
    const token = credenciaisData.token;
    if (!token) {
      return res.status(401).json({ error: 'Token não recebido na primeira etapa' });
    }

    // 2ª etapa: trocar token pelo auth_token
    console.log('🔄 Trocando token pelo auth_token...');
    const authResponse = await fetch('https://edusp-api.ip.tv/registration/edusp/token', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'origin': 'https://saladofuturo.educacao.sp.gov.br',
        'referer': 'https://saladofuturo.educacao.sp.gov.br/',
        'x-api-platform': 'webclient',
        'x-api-realm': 'edusp',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({ token })
    });

    if (!authResponse.ok) {
      const errorText = await authResponse.text();
      console.error('❌ Erro na 2ª etapa:', authResponse.status, errorText);
      return res.status(401).json({ error: 'Falha na troca do token' });
    }

    const authData = await authResponse.json();
    const authToken = authData.auth_token;
    const nick = authData.nick || '';

    console.log('✅ Login bem-sucedido, auth_token obtido');
    res.json({
      auth_token: authToken,
      nick: nick,
      realm: 'edusp'
    });

  } catch (error) {
    console.error('🔥 Erro inesperado no login:', error.message);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// ==================== ROTAS PROXY PARA API DA EDUSP ====================
app.get('/room/user', (req, res) => {
  console.log('📥 Buscando salas do usuário');
  proxyRequest(req, res, '/room/user', 'GET');
});

app.get('/tms/task/todo', (req, res) => {
  console.log('📥 Buscando tarefas (redações)');
  proxyRequest(req, res, '/tms/task/todo', 'GET');
});

app.get('/tms/task/:id/apply', (req, res) => {
  const endpoint = `/tms/task/${req.params.id}/apply${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;
  console.log(`📥 Aplicando à tarefa ${req.params.id}`);
  proxyRequest(req, res, endpoint, 'GET');
});

app.post('/complete', (req, res) => {
  console.log('📥 Salvando rascunho:', req.body.task_id);
  proxyRequest(req, res, '/complete', 'POST');
});

// ==================== ROTA DE GERAÇÃO COM IA (OPENROUTER) ====================
app.post('/generate_essay', async (req, res) => {
  const { genre, prompt } = req.body;

  const userMessage = `Você é um assistente especializado em escrever redações escolares. 
Gênero: ${genre}. 
Baseie-se no seguinte enunciado e textos de apoio para produzir uma redação completa, com título e desenvolvimento. 
Formate a resposta exatamente assim:

TITULO: (título da redação)
TEXTO: (texto completo da redação, com parágrafos)

Segue o conteúdo:
${prompt}`;

  try {
    console.log('🤖 Gerando redação com OpenRouter...');
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://network-redacao.onrender.com',
        'X-Title': 'Network Redação'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.7,
        max_tokens: 2000
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || 'Erro na OpenRouter');
    }

    const iaResponse = data.choices[0].message.content;
    console.log('✅ Redação gerada com sucesso');
    res.json({ success: true, response: iaResponse });
  } catch (error) {
    console.error('❌ Erro ao chamar OpenRouter:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Rota de teste
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor proxy rodando em http://localhost:${PORT}`);
  console.log(`🔗 Rotas redirecionadas para: ${EDUSP_API_BASE}`);
});
