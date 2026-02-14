const express = require('express');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIGURAÇÕES ====================
const REMOTE_BASE = 'https://network-class.onrender.com'; // servidor remoto (corrigido)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL = 'openai/gpt-oss-120b:free';

// ==================== FUNÇÃO PROXY MELHORADA ====================
async function proxyRequest(req, res, endpoint, method = req.method) {
  try {
    // Constrói a query string corretamente
    const queryString = Object.keys(req.query).length > 0 
      ? '?' + new URLSearchParams(req.query).toString() 
      : '';
    const fullEndpoint = endpoint + queryString;
    const url = `${REMOTE_BASE}${fullEndpoint}`;
    
    // Prepara headers, removendo os que causam conflito
    const headers = {
      ...req.headers,
      host: new URL(REMOTE_BASE).hostname,
    };
    delete headers['content-length'];
    delete headers['connection'];
    delete headers['accept-encoding']; // evita problemas com compressão

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

    console.log(`[PROXY] ${method} ${fullEndpoint} -> ${url}`);

    const response = await fetch(url, options);
    
    let data;
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    console.log(`[PROXY] Resposta de ${fullEndpoint}: status ${response.status}`);
    
    // Copia headers importantes da resposta
    const relevantHeaders = ['content-type', 'set-cookie', 'authorization'];
    relevantHeaders.forEach(header => {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    });
    
    res.status(response.status).send(data);
  } catch (error) {
    console.error(`[PROXY] Erro em ${endpoint}:`, error.message);
    console.error(`[PROXY] Stack trace:`, error.stack);
    res.status(500).json({ 
      error: 'Erro ao comunicar com servidor remoto', 
      details: error.message,
      endpoint: endpoint
    });
  }
}

// ==================== ROTAS PROXY ====================
app.post('/registration/edusp', (req, res) => {
  console.log('📥 Requisição de login recebida:', req.body);
  proxyRequest(req, res, '/registration/edusp', 'POST');
});

app.get('/room/user', (req, res) => {
  console.log('📥 Buscando salas do usuário');
  proxyRequest(req, res, '/room/user', 'GET');
});

app.get('/tms/task/todo', (req, res) => {
  console.log('📥 Buscando tarefas (redações)');
  proxyRequest(req, res, '/tms/task/todo', 'GET');
});

app.get('/tms/task/:id/apply', (req, res) => {
  const taskId = req.params.id;
  console.log(`📥 Aplicando à tarefa ${taskId}`, { query: req.query });
  const endpoint = `/tms/task/${taskId}/apply`;
  proxyRequest(req, res, endpoint, 'GET');
});

app.post('/complete', (req, res) => {
  console.log('📥 Salvando rascunho:', req.body.task_id);
  proxyRequest(req, res, '/complete', 'POST');
});

// ==================== ROTA DE GERAÇÃO COM IA (OPENROUTER) ====================
app.post('/generate_essay', async (req, res) => {
  const { genre, prompt } = req.body;

  if (!genre || !prompt) {
    return res.status(400).json({ 
      success: false, 
      message: 'Genre e prompt são obrigatórios' 
    });
  }

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
      throw new Error(data.error?.message || `Erro na OpenRouter: ${response.status}`);
    }

    const iaResponse = data.choices[0]?.message?.content;
    if (!iaResponse) {
      throw new Error('Resposta inválida da OpenRouter');
    }
    
    console.log('✅ Redação gerada com sucesso');
    res.json({ success: true, response: iaResponse });
  } catch (error) {
    console.error('❌ Erro ao chamar OpenRouter:', error.message);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Rota de teste para verificar se o servidor está online
app.get('/ping', (req, res) => {
  res.json({ status: 'pong', timestamp: new Date().toISOString() });
});

// Middleware para requisições não encontradas
app.use((req, res) => {
  console.warn(`⚠️  Rota não encontrada: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Rota não encontrada', 
    path: req.path,
    method: req.method
  });
});

// Middleware para tratamento de erros
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  res.status(500).json({ 
    error: 'Erro interno do servidor',
    message: err.message,
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor proxy rodando em http://localhost:${PORT}`);
  console.log(`🔗 Redirecionando requisições para: ${REMOTE_BASE}`);
  console.log(`📝 Ambiente: ${process.env.NODE_ENV || 'development'}`);
});
