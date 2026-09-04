// server.js
// OpenAI-compatible Proxy -> NVIDIA NIM
// Compatível com Janitor AI / OpenAI API

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÃO NVIDIA NIM
// ============================================================

const NIM_API_BASE =
  process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';

const NIM_API_KEY = process.env.NIM_API_KEY;

// ============================================================
// CONFIGURAÇÕES
// ============================================================

// Modelo NVIDIA principal.
// Atualmente disponível no endpoint gratuito da NVIDIA.
const DEFAULT_NIM_MODEL = 'openai/gpt-oss-20b';

// Mostrar reasoning no texto?
// false = Janitor recebe apenas a resposta final.
const SHOW_REASONING = false;

// ============================================================
// MAPEAMENTO DOS MODELOS
// ============================================================
//
// O Janitor pode enviar nomes como:
// claude-3-opus
// gpt-4
// gpt-4o
//
// Eles serão convertidos para um modelo NVIDIA válido.
//

const MODEL_MAPPING = {
  'gpt-3.5-turbo': DEFAULT_NIM_MODEL,
  'gpt-4': DEFAULT_NIM_MODEL,
  'gpt-4-turbo': DEFAULT_NIM_MODEL,
  'gpt-4o': DEFAULT_NIM_MODEL,

  'claude-3-opus': DEFAULT_NIM_MODEL,
  'claude-3-sonnet': DEFAULT_NIM_MODEL,

  'gemini-pro': DEFAULT_NIM_MODEL,

  // Caso o Janitor envie diretamente o modelo NVIDIA
  'openai/gpt-oss-20b': DEFAULT_NIM_MODEL
};

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: '10mb'
  })
);

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI -> NVIDIA NIM Proxy',
    message: 'Proxy is running',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions'
    }
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    nvidia_api: NIM_API_BASE,
    default_model: DEFAULT_NIM_MODEL,
    reasoning_display: SHOW_REASONING,
    api_key_configured: !!NIM_API_KEY
  });
});

// ============================================================
// MODELS
// ============================================================
//
// Endpoint compatível com OpenAI:
// GET /v1/models
//

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map((model) => ({
    id: model,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'nvidia-nim-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// ============================================================
// CHAT COMPLETIONS
// ============================================================
//
// POST /v1/chat/completions
//

app.post('/v1/chat/completions', async (req, res) => {
  try {
    // --------------------------------------------------------
    // Verificar API KEY
    // --------------------------------------------------------

    if (!NIM_API_KEY) {
      console.error('NIM_API_KEY não configurada.');

      return res.status(500).json({
        error: {
          message:
            'NIM_API_KEY is not configured in Vercel Environment Variables.',
          type: 'configuration_error',
          code: 500
        }
      });
    }

    // --------------------------------------------------------
    // Ler dados enviados pelo Janitor
    // --------------------------------------------------------

    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream,
      top_p,
      stop,
      presence_penalty,
      frequency_penalty,
      reasoning_effort,
      tools,
      tool_choice
    } = req.body;

    // --------------------------------------------------------
    // Validação
    // --------------------------------------------------------

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: 'The "messages" field is required and must be an array.',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    // --------------------------------------------------------
    // Escolher modelo NVIDIA
    // --------------------------------------------------------

    let nimModel = MODEL_MAPPING[model];

    // Se o Janitor mandar um modelo desconhecido,
    // usamos o modelo NVIDIA padrão.
    if (!nimModel) {
      nimModel = DEFAULT_NIM_MODEL;
    }

    console.log('========================================');
    console.log('Incoming request');
    console.log('Janitor model:', model);
    console.log('NVIDIA model:', nimModel);
    console.log('Messages:', messages.length);
    console.log('Stream:', stream);
    console.log('========================================');

    // --------------------------------------------------------
    // Montar requisição para NVIDIA
    // --------------------------------------------------------

    const nimRequest = {
      model: nimModel,
      messages: messages,

      // NVIDIA aceita temperature de 0 a 1 para gpt-oss-20b.
      temperature:
        typeof temperature === 'number'
          ? Math.min(Math.max(temperature, 0), 1)
          : 0.6,

      max_tokens:
        typeof max_tokens === 'number'
          ? Math.min(Math.max(max_tokens, 1), 4096)
          : 4096,

      stream: stream === true
    };

    // --------------------------------------------------------
    // Parâmetros opcionais
    // --------------------------------------------------------

    if (typeof top_p === 'number') {
      nimRequest.top_p = Math.min(Math.max(top_p, 0), 1);
    }

    if (typeof presence_penalty === 'number') {
      nimRequest.presence_penalty = presence_penalty;
    }

    if (typeof frequency_penalty === 'number') {
      nimRequest.frequency_penalty = frequency_penalty;
    }

    if (stop !== undefined && stop !== null) {
      nimRequest.stop = stop;
    }

    if (reasoning_effort) {
      nimRequest.reasoning_effort = reasoning_effort;
    }

    if (Array.isArray(tools)) {
      nimRequest.tools = tools;
    }

    if (tool_choice !== undefined) {
      nimRequest.tool_choice = tool_choice;
    }

    // --------------------------------------------------------
    // Enviar para NVIDIA
    // --------------------------------------------------------

    console.log('Sending request to NVIDIA...');

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: stream
            ? 'text/event-stream'
            : 'application/json'
        },

        responseType: stream ? 'stream' : 'json',

        // Não deixar o Axios transformar erros HTTP
        // antes de conseguirmos mostrar o erro real da NVIDIA.
        validateStatus: () => true,

        timeout: 120000
      }
    );

    // --------------------------------------------------------
    // NVIDIA retornou erro
    // --------------------------------------------------------

    if (response.status < 200 || response.status >= 300) {
      let errorData = response.data;

      // Se a resposta não for stream, podemos acessar diretamente.
      if (!stream) {
        console.error('========================================');
        console.error('NVIDIA API ERROR');
        console.error('Status:', response.status);
        console.error('Response:', errorData);
        console.error('========================================');

        return res.status(response.status).json({
          error: {
            message:
              errorData?.detail ||
              errorData?.message ||
              errorData?.error?.message ||
              `NVIDIA API returned status ${response.status}`,

            type: 'nvidia_api_error',

            code: response.status,

            upstream: errorData
          }
        });
      }
    }

    // ========================================================
    // STREAMING
    // ========================================================

    if (stream === true) {
      res.statusCode = response.status;

      res.setHeader(
        'Content-Type',
        'text/event-stream; charset=utf-8'
      );

      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      let buffer = '';

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();

        const lines = buffer.split('\n');

        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed) {
            continue;
          }

          // NVIDIA envia:
          // data: {...}
          // data: [DONE]

          if (!trimmed.startsWith('data:')) {
            continue;
          }

          const dataString = trimmed.slice(5).trim();

          // --------------------------------------------------
          // FINAL DO STREAM
          // --------------------------------------------------

          if (dataString === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }

          // --------------------------------------------------
          // Tentar interpretar JSON
          // --------------------------------------------------

          try {
            const data = JSON.parse(dataString);

            const choice = data?.choices?.[0];

            if (choice?.delta) {
              const reasoning =
                choice.delta.reasoning_content;

              const content =
                choice.delta.content;

              // ------------------------------------------------
              // Remover reasoning
              // ------------------------------------------------

              if (!SHOW_REASONING) {
                delete choice.delta.reasoning_content;

                if (
                  content === null ||
                  content === undefined
                ) {
                  choice.delta.content = '';
                }
              }

              // ------------------------------------------------
              // Mostrar reasoning como <think>
              // ------------------------------------------------

              if (SHOW_REASONING && reasoning) {
                choice.delta.content =
                  `<think>${reasoning}</think>`;

                delete choice.delta.reasoning_content;
              }
            }

            res.write(
              `data: ${JSON.stringify(data)}\n\n`
            );
          } catch (err) {
            // Se não for JSON válido,
            // simplesmente encaminhamos.
            res.write(`${trimmed}\n\n`);
          }
        }
      });

      response.data.on('end', () => {
        res.end();
      });

      response.data.on('error', (error) => {
        console.error(
          'NVIDIA stream error:',
          error.message
        );

        if (!res.headersSent) {
          res.status(500);
        }

        res.end();
      });

      return;
    }

    // ========================================================
    // RESPOSTA NORMAL
    // ========================================================

    const nvidiaData = response.data;

    // --------------------------------------------------------
    // Pegar resposta do NVIDIA
    // --------------------------------------------------------

    const choices = Array.isArray(nvidiaData?.choices)
      ? nvidiaData.choices
      : [];

    // --------------------------------------------------------
    // Converter para formato OpenAI
    // --------------------------------------------------------

    const openaiResponse = {
      id:
        nvidiaData?.id ||
        `chatcmpl-${Date.now()}`,

      object: 'chat.completion',

      created:
        nvidiaData?.created ||
        Math.floor(Date.now() / 1000),

      model: model || nimModel,

      choices: choices.map((choice, index) => {
        let content =
          choice?.message?.content || '';

        // ----------------------------------------------------
        // Reasoning
        // ----------------------------------------------------

        if (
          SHOW_REASONING &&
          choice?.message?.reasoning_content
        ) {
          content =
            `<think>\n${choice.message.reasoning_content}\n</think>\n\n${content}`;
        }

        return {
          index:
            typeof choice.index === 'number'
              ? choice.index
              : index,

          message: {
            role:
              choice?.message?.role ||
              'assistant',

            content: content
          },

          finish_reason:
            choice?.finish_reason || 'stop'
        };
      }),

      usage:
        nvidiaData?.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
    };

    console.log('NVIDIA request successful.');

    return res.json(openaiResponse);
  } catch (error) {
    // ========================================================
    // ERRO GERAL
    // ========================================================

    console.error('========================================');
    console.error('PROXY ERROR');
    console.error('Message:', error.message);
    console.error('Status:', error.response?.status);
    console.error(
      'NVIDIA response:',
      error.response?.data
    );
    console.error('========================================');

    const status =
      error.response?.status || 500;

    const upstream =
      error.response?.data;

    const message =
      upstream?.detail ||
      upstream?.message ||
      upstream?.error?.message ||
      error.message ||
      'Internal server error';

    return res.status(status).json({
      error: {
        message: message,

        type:
          status >= 500
            ? 'server_error'
            : 'invalid_request_error',

        code: status,

        upstream: upstream || null
      }
    });
  }
});

// ============================================================
// 404
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.method} ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log('========================================');
  console.log('OpenAI -> NVIDIA NIM Proxy');
  console.log('========================================');
  console.log(`Port: ${PORT}`);
  console.log(`NVIDIA API: ${NIM_API_BASE}`);
  console.log(`Default model: ${DEFAULT_NIM_MODEL}`);
  console.log(
    `Reasoning display: ${
      SHOW_REASONING ? 'ENABLED' : 'DISABLED'
    }`
  );
  console.log(
    `NVIDIA API Key: ${
      NIM_API_KEY ? 'CONFIGURED' : 'MISSING'
    }`
  );
  console.log('========================================');
});
