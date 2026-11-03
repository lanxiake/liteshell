/**
 * The vendors people actually point this app at, and the address + model names
 * that work for each.
 *
 * Data, not code: the model ids and context windows below are a snapshot of
 * <https://models.dev> (MIT, github.com/anomalyco/models.dev), trimmed to the
 * handful of current models per vendor. The snapshot is vendored rather than
 * fetched because the renderer's CSP forbids outbound requests, the app must
 * configure itself offline, and a settings dialog that depends on a website
 * being up is a settings dialog that breaks on a plane.
 *
 * Model names go stale; the "拉取模型" button reads the live list from the
 * endpoint and replaces these candidates, and typing a name still works. Treat
 * this table as a good first guess, never as the truth.
 */
export interface PresetModel {
  id: string
  /** Rounded down to a multiple of 8 so the compaction trigger (90% of this)
   *  stays under the real window. */
  contextK: number
}

export interface ProviderPreset {
  id: string
  label: string
  /** Which wire dialect. Anthropic's own SDK; everything else /chat/completions. */
  kind: 'anthropic' | 'openai'
  /** Empty = the vendor's default address (correct only for OpenAI/Anthropic). */
  baseUrl: string
  /** Shown under the form: where to get a key, or what is special about it. */
  note: string
  models: PresetModel[]
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    note: '深度求索。便宜、支持工具调用，适合跑命令。',
    models: [
      { id: 'deepseek-flash', contextK: 1024 },
      { id: 'deepseek-v4-pro', contextK: 1024 }
    ]
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi（国内）',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    note: '月之暗面。国内直连，长上下文。',
    models: [
      { id: 'kimi-k3.1-pro', contextK: 1024 },
      { id: 'kimi-k3', contextK: 1024 },
      { id: 'kimi-k2.7-code', contextK: 256 }
    ]
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    note: '智谱开放平台。免费档也能调工具。',
    models: [
      { id: 'glm-5.3-flash', contextK: 976 },
      { id: 'glm-5.3', contextK: 976 },
      { id: 'glm-4.7', contextK: 200 }
    ]
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    kind: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    note: '阿里云百炼的 OpenAI 兼容入口。',
    models: [
      { id: 'qwen3.8-flash', contextK: 976 },
      { id: 'qwen3.8-max', contextK: 976 },
      { id: 'qwen3.5-plus', contextK: 976 }
    ]
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    note: '一个地址调多家开源模型，模型名带厂商前缀。',
    models: [
      { id: 'zai-org/GLM-5.3', contextK: 1024 },
      { id: 'Qwen/Qwen3.8-27B', contextK: 256 },
      { id: 'deepseek-ai/DeepSeek-V4-Flash', contextK: 976 }
    ]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    note: '海外聚合网关，一家 Key 调所有模型。',
    models: [
      { id: 'deepseek/deepseek-v4.1-flash-1017', contextK: 1024 },
      { id: 'moonshotai/kimi-k3.1-pro', contextK: 1024 },
      { id: 'z-ai/glm-5.3', contextK: 1024 }
    ]
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: '',
    note: '留空接口地址即用官方地址。',
    models: [
      { id: 'gpt-6.1-terra', contextK: 1024 },
      { id: 'gpt-6.1-sol', contextK: 1024 }
    ]
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: '',
    note: '留空接口地址即用官方地址；走 Anthropic 原生协议，能保留思考内容。',
    models: [
      { id: 'claude-opus-5', contextK: 976 },
      { id: 'claude-sonnet-5', contextK: 976 },
      { id: 'claude-haiku-4-5-20251001', contextK: 200 }
    ]
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本机）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    note: '本机加载的模型，一般不用 Key。模型名点「拉取模型」读回来。',
    models: []
  },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    note: '本机 ollama，不用 Key。模型名用 `ollama list` 里的那个，或者点「拉取模型」。',
    models: []
  },
  {
    id: 'custom',
    label: '自定义 / 中转网关',
    kind: 'openai',
    baseUrl: '',
    note: '自建中转、公司网关、任何 OpenAI 兼容地址。地址填到 /v1 为止。',
    models: []
  }
]

/** The preset that matches what is currently saved, so the form opens on the
 *  vendor the user already chose instead of on the first row. */
export function presetFor(provider: string, baseUrl: string): ProviderPreset | undefined {
  const url = baseUrl.trim().replace(/\/+$/, '')
  return PRESETS.find(
    (p) => p.kind === provider && p.baseUrl.replace(/\/+$/, '') === url && url !== ''
  ) ?? (url === '' ? PRESETS.find((p) => p.kind === provider && p.baseUrl === '') : undefined)
}
