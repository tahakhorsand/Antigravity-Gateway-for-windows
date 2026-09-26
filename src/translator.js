import crypto from 'crypto';

export function normalizeModelName(inputModel) {
  if (!inputModel) return 'gemini-3.8-flash';
  const m = inputModel.toLowerCase().trim();

  // Gemini 3.8 Flash (User primary model)
  if (m.includes('3.8') || m.includes('3-8') || m === 'gemini-3.8-flash-medium' || m === 'gemini-3.8-flash') {
    return 'gemini-3.8-flash';
  }

  // Gemini 3.7 Flash
  if (m.includes('3.7') || m.includes('3-7')) {
    return 'gemini-3.7-flash';
  }

  // Gemini 3 Flash / 3.5 Flash
  if (m.includes('3.5-flash') || m.includes('gemini-3-flash') || m === 'gemini-3-flash') {
    return 'gemini-3-flash';
  }

  // Explicit 2.5 Flash
  if (m.includes('2.5-flash') || m.includes('2.5-flash-lite')) {
    return 'gemini-2.5-flash';
  }

  // Other lightweight / turbo aliases default to 3.8 flash
  if (m.includes('flash-lite') || m.includes('mini') || m.includes('3.5-turbo') || m.includes('haiku')) {
    return 'gemini-3.8-flash';
  }

  // Generic flash defaults to 3.8 flash
  if (m.includes('flash')) {
    return 'gemini-3.8-flash';
  }

  // Pro & Frontier models
  if (m.includes('3.1-pro') || m.includes('3-1-pro')) {
    return 'gemini-3.1-pro-high';
  }
  if (m.includes('2.5-pro') || m.includes('2-5-pro')) {
    return 'gemini-2.5-pro';
  }
  if (m.includes('pro') || m.includes('4o') || m.includes('claude') || m.includes('sonnet') || m.includes('opus')) {
    return 'gemini-2.5-pro';
  }

  return inputModel;
}

// Map OpenAI messages array to Gemini contents structure
export function convertOpenAIToGemini(body) {
  const model = normalizeModelName(body.model);
  let systemInstruction = undefined;
  const contents = [];

  const rawMessages = body.messages || [];
  for (const msg of rawMessages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      systemInstruction = {
        parts: [{ text }]
      };
    } else {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts = [];

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === 'text') {
            parts.push({ text: item.text });
          } else if (item.type === 'image_url' && item.image_url?.url) {
            const url = item.image_url.url;
            if (url.startsWith('data:')) {
              const [meta, base64] = url.split(',');
              const mimeMatch = meta.match(/data:([^;]+)/);
              parts.push({
                inline_data: {
                  mime_type: mimeMatch ? mimeMatch[1] : 'image/jpeg',
                  data: base64
                }
              });
            }
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }
  }

  const generationConfig = {};
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;
  if (body.presence_penalty !== undefined) generationConfig.presencePenalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined) generationConfig.frequencyPenalty = body.frequency_penalty;

  return {
    model,
    geminiBody: {
      contents,
      system_instruction: systemInstruction,
      generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined
    }
  };
}

// Map Anthropic /v1/messages body to Gemini
export function convertAnthropicToGemini(body) {
  const model = normalizeModelName(body.model);
  let systemInstruction = undefined;
  if (body.system) {
    const text = typeof body.system === 'string' ? body.system : JSON.stringify(body.system);
    systemInstruction = { parts: [{ text }] };
  }

  const contents = [];
  const rawMessages = body.messages || [];
  for (const msg of rawMessages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item.type === 'text') {
          parts.push({ text: item.text });
        } else if (item.type === 'image' && item.source?.data) {
          parts.push({
            inline_data: {
              mime_type: item.source.media_type || 'image/jpeg',
              data: item.source.data
            }
          });
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  const generationConfig = {};
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.max_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens;

  return {
    model,
    geminiBody: {
      contents,
      system_instruction: systemInstruction,
      generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined
    }
  };
}

export const CLOUDCODE_GENERATE_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
  'https://cloudcode-pa.googleapis.com/v1internal:generateContent'
];

export const CLOUDCODE_STREAM_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
];

export function mapToGoogleInternalModel(model) {
  if (!model) return 'gemini-3.8-flash-medium';
  const m = model.toLowerCase().trim();
  if (m === 'gemini-3.8-flash' || m.includes('3.8-flash') || m.includes('3.8')) {
    return 'gemini-3.8-flash-medium';
  }
  if (m === 'gemini-3.7-flash' || m.includes('3.7-flash')) {
    return 'gemini-3.7-flash-medium';
  }
  if (m === 'gemini-3-flash' || m.includes('3-flash')) {
    return 'gemini-3-flash';
  }
  if (m === 'gemini-2.5-flash' || m.includes('2.5-flash')) {
    return 'gemini-2.5-flash';
  }
  if (m === 'gemini-2.5-pro' || m.includes('2.5-pro')) {
    return 'gemini-2.5-pro';
  }
  return model;
}

export function wrapGeminiV1Internal(geminiBody, model, projectId) {
  const internalModel = mapToGoogleInternalModel(model);
  return {
    project: projectId || undefined,
    model: internalModel,
    request: {
      contents: geminiBody.contents || [],
      systemInstruction: geminiBody.system_instruction || undefined,
      generationConfig: geminiBody.generationConfig || undefined
    }
  };
}

// Convert Gemini generateContent result to OpenAI chat completion format
export function convertGeminiToOpenAI(geminiRes, modelName, originalId = null) {
  const id = originalId || `chatcmpl-${crypto.randomUUID()}`;
  const root = geminiRes.response || geminiRes;
  const candidate = root.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');

  const usage = root.usageMetadata || geminiRes.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const candidateTokens = usage.candidatesTokenCount || 0;
  const totalTokens = usage.totalTokenCount || (promptTokens + candidateTokens);

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : (candidate?.finishReason?.toLowerCase() || 'stop')
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: candidateTokens,
      total_tokens: totalTokens
    }
  };
}

// Convert Gemini generateContent result to Anthropic message format
export function convertGeminiToAnthropic(geminiRes, modelName, originalId = null) {
  const id = originalId || `msg_${crypto.randomUUID()}`;
  const root = geminiRes.response || geminiRes;
  const candidate = root.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');

  const usage = root.usageMetadata || geminiRes.usageMetadata || {};
  const promptTokens = usage.promptTokenCount || 0;
  const candidateTokens = usage.candidatesTokenCount || 0;

  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text
      }
    ],
    model: modelName,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: promptTokens,
      output_tokens: candidateTokens
    }
  };
}

// Build standard OpenAI models list
export function getOpenAIModelsList() {
  return {
    object: 'list',
    data: [
      { id: 'gemini-3.8-flash', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'gemini-3.8-flash-medium', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'gemini-3.7-flash', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'gemini-3-flash', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'gemini-2.5-flash', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'gemini-2.5-pro', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'gemini-3.1-pro-high', object: 'model', created: 1715000000, owned_by: 'google' },
      { id: 'claude-3-5-sonnet', object: 'model', created: 1715000000, owned_by: 'anthropic-alias' },
      { id: 'claude-3-7-sonnet', object: 'model', created: 1715000000, owned_by: 'anthropic-alias' },
      { id: 'gpt-4o', object: 'model', created: 1715000000, owned_by: 'openai-alias' },
      { id: 'gpt-4o-mini', object: 'model', created: 1715000000, owned_by: 'openai-alias' }
    ]
  };
}
