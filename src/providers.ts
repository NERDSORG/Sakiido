/**
 * Provider ID remapping and assistant `api` inference for the v0 → v1
 * migration step.
 *
 * 0.0.8 providers were user-named entries of the `mutsumi.providers` setting
 * (all OpenAI-compatible chat-completions endpoints), with the built-in
 * default "kimi-for-coding". Format v1 resolves providers through the pi-ai
 * registry, where the equivalent built-in provider is "kimi-coding"
 * (api: anthropic-messages) and the old ID is explicitly rejected.
 *
 * The api map mirrors @earendil-works/pi-ai builtin provider definitions;
 * anything unknown falls back to openai-completions, which matches what
 * 0.0.8 actually spoke.
 */

export const REMOVED_PROVIDER_REMAP: Record<string, string> = {
    'kimi-for-coding': 'kimi-coding',
};

export const DEFAULT_LEGACY_API = 'openai-completions';

export const PROVIDER_API: Record<string, string> = {
    'amazon-bedrock': 'bedrock-converse-stream',
    'anthropic': 'anthropic-messages',
    'ant-ling': 'openai-completions',
    'azure-openai-responses': 'azure-openai-responses',
    'cerebras': 'openai-completions',
    'cloudflare-ai-gateway': 'openai-completions',
    'cloudflare-workers-ai': 'openai-completions',
    'deepseek': 'openai-completions',
    'fireworks': 'openai-completions',
    'github-copilot': 'anthropic-messages',
    'google': 'google-generative-ai',
    'google-vertex': 'google-vertex',
    'groq': 'openai-completions',
    'huggingface': 'openai-completions',
    'kimi-coding': 'anthropic-messages',
    'minimax': 'anthropic-messages',
    'minimax-cn': 'anthropic-messages',
    'mistral': 'mistral-conversations',
    'moonshotai': 'openai-completions',
    'moonshotai-cn': 'openai-completions',
    'nvidia': 'openai-completions',
    'openai': 'openai-responses',
    'openai-codex': 'openai-codex-responses',
    'opencode': 'openai-completions',
    'opencode-go': 'openai-completions',
    'openrouter': 'openai-completions',
    'qwen-token-plan': 'openai-completions',
    'qwen-token-plan-cn': 'openai-completions',
    'radius': 'openai-completions',
    'together': 'openai-completions',
    'vercel-ai-gateway': 'anthropic-messages',
    'xai': 'openai-completions',
    'xiaomi': 'openai-completions',
    'xiaomi-token-plan-ams': 'openai-completions',
    'xiaomi-token-plan-cn': 'openai-completions',
    'xiaomi-token-plan-sgp': 'openai-completions',
    'zai': 'openai-completions',
    'zai-coding-cn': 'openai-completions',
};

export function remapProvider(provider: string): { provider: string; remapped: boolean } {
    const mapped = REMOVED_PROVIDER_REMAP[provider];
    return mapped ? { provider: mapped, remapped: true } : { provider, remapped: false };
}

export function inferApi(provider: string): string {
    return PROVIDER_API[provider] ?? DEFAULT_LEGACY_API;
}
