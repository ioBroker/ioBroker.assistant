export interface AdapterConfig {
    provider: 'openai' | 'anthropic';
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
    allowControl: boolean;
    systemPrompt: string;
}
