'use strict';
// Integration test: provider preset resolution (SDK, base URL, default model).
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveProvider, LlmAgent } = require('../../build/lib/llm.js');

const log = { level: 'info', debug() {}, info() {}, warn() {}, error() {}, silly() {} };

/** Send one side-job prompt through an agent and return the request the OpenAI SDK got. */
async function sentRequest(provider) {
    const agent = new LlmAgent({ provider, apiKey: 'test', model: 'some-model', baseUrl: 'http://x/v1', log });
    let request;
    agent.openai.chat.completions.create = async req => {
        request = req;
        return { choices: [{ message: { content: 'ok' } }] };
    };
    await agent.complete('ping', 8);
    return request;
}

test('openai / anthropic use the vendor SDK with the default endpoint', () => {
    const o = resolveProvider('openai');
    assert.equal(o.sdk, 'openai');
    assert.equal(o.baseUrl, '');
    assert.ok(o.defaultModel);

    const a = resolveProvider('anthropic');
    assert.equal(a.sdk, 'anthropic');
    assert.equal(a.baseUrl, '');
    assert.match(a.defaultModel, /claude/);
});

test('gemini / deepseek use the OpenAI SDK with a fixed base URL', () => {
    const g = resolveProvider('gemini', 'http://ignored-for-gemini');
    assert.equal(g.sdk, 'openai');
    assert.match(g.baseUrl, /generativelanguage\.googleapis\.com/);
    assert.ok(g.defaultModel);

    const d = resolveProvider('deepseek');
    assert.equal(d.sdk, 'openai');
    assert.match(d.baseUrl, /api\.deepseek\.com/);
    assert.match(d.defaultModel, /deepseek/);
});

test('custom uses the configured base URL; unknown falls back to openai', () => {
    assert.equal(resolveProvider('custom', 'http://x/v1').baseUrl, 'http://x/v1');
    assert.equal(resolveProvider('custom', '').baseUrl, '');
    assert.equal(resolveProvider(undefined).sdk, 'openai');
    assert.equal(resolveProvider('nonsense').sdk, 'openai');
});

test('openai gets max_completion_tokens, OpenAI-compatible providers keep max_tokens', async () => {
    const o = await sentRequest('openai');
    assert.ok(o.max_completion_tokens >= 1024, 'room for reasoning tokens');
    assert.equal('max_tokens' in o, false);

    const c = await sentRequest('custom');
    assert.equal(c.max_tokens, 8);
    assert.equal('max_completion_tokens' in c, false);
});

/** An API error like the OpenAI SDK throws it. */
function apiError(status, message) {
    return Object.assign(new Error(`${status} ${message}`), { status });
}

const TOOLS_WITH_EFFORT =
    "Function tools with reasoning_effort are not supported for gpt-x in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

/** An agent with one tool `get_value`, its trace and every request the OpenAI SDK got. */
function toolAgent(model, opts = {}) {
    const steps = [];
    const ran = [];
    const agent = new LlmAgent({
        provider: 'openai',
        apiKey: 'test',
        model,
        tools: [
            {
                name: 'get_value',
                description: 'reads a value',
                parameters: { type: 'object', properties: {} },
                run: async () => {
                    ran.push('get_value');
                    return { value: 42 };
                },
            },
        ],
        log,
        trace: step => steps.push(step),
        ...opts,
    });
    return { agent, steps, ran };
}

test('openai: the configured reasoning effort goes with the request, not to other providers', async () => {
    const { agent } = toolAgent('effort-model', { reasoningEffort: 'low' });
    let request;
    agent.openai.chat.completions.create = async req => {
        request = req;
        return { choices: [{ message: { content: 'ok' } }] };
    };
    assert.equal(await agent.ask('hi'), 'ok');
    assert.equal(request.reasoning_effort, 'low');

    const other = new LlmAgent({ provider: 'gemini', apiKey: 't', model: 'g', tools: [], log, reasoningEffort: 'low' });
    other.openai.chat.completions.create = async req => {
        request = req;
        return { choices: [{ message: { content: 'ok' } }] };
    };
    await other.ask('hi');
    assert.equal('reasoning_effort' in request, false);
});

test('openai: function tools refused with the default reasoning → retried with "none", remembered', async () => {
    const { agent, steps, ran } = toolAgent('none-model');
    const sent = [];
    agent.openai.chat.completions.create = async req => {
        sent.push(req.reasoning_effort);
        if (req.reasoning_effort !== 'none') {
            throw apiError(400, TOOLS_WITH_EFFORT);
        }
        if (!req.messages.some(m => m.role === 'tool')) {
            return {
                choices: [
                    {
                        message: {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                { id: 'c1', type: 'function', function: { name: 'get_value', arguments: '{}' } },
                            ],
                        },
                    },
                ],
            };
        }
        return { choices: [{ message: { role: 'assistant', content: 'It is 42.' } }] };
    };
    assert.equal(await agent.ask('value?'), 'It is 42.');
    assert.deepEqual(sent, [undefined, 'none', 'none']);
    assert.deepEqual(ran, ['get_value']);
    const retries = steps.filter(s => s.level === 'warn');
    assert.equal(retries.length, 1, 'the retry is its own step');
    assert.match(retries[0].title, /"none"/);
    assert.equal(
        steps.some(s => s.level === 'error'),
        false,
        'no failed round in the trace',
    );

    // the next question sends "none" at once
    sent.length = 0;
    assert.equal(await agent.ask('again?'), 'It is 42.');
    assert.equal(sent[0], 'none');
});

/** A Responses API mock: first a reasoning item and a call of `get_value`, then the answer. */
function responsesMock(agent) {
    const requests = [];
    agent.openai.responses.create = async req => {
        requests.push(JSON.parse(JSON.stringify(req)));
        if (!req.input.some(i => i.type === 'function_call_output')) {
            return {
                status: 'completed',
                output: [
                    { type: 'reasoning', id: 'r1', encrypted_content: 'enc' },
                    { type: 'function_call', call_id: 'call1', name: 'get_value', arguments: '{}' },
                ],
                usage: { input_tokens: 10, output_tokens: 5 },
            };
        }
        return {
            status: 'completed',
            output: [],
            output_text: ' It is 42. ',
            usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 16 } },
        };
    };
    return requests;
}

test('openai: a model that refuses "none" too switches to the Responses API', async () => {
    const { agent, steps, ran } = toolAgent('responses-model', { systemPrompt: 'be brief' });
    let chatCalls = 0;
    agent.openai.chat.completions.create = async req => {
        chatCalls++;
        throw apiError(
            400,
            req.reasoning_effort === 'none' ? "Unsupported value: 'none' for reasoning_effort" : TOOLS_WITH_EFFORT,
        );
    };
    const requests = responsesMock(agent);
    assert.equal(await agent.ask('value?'), 'It is 42.');
    assert.equal(chatCalls, 2);
    assert.deepEqual(ran, ['get_value']);
    assert.equal(requests[0].instructions, 'be brief');
    assert.equal(requests[0].reasoning, undefined, 'no effort chosen: the model reasons with its default');
    assert.equal(requests[0].store, false);
    assert.deepEqual(requests[0].include, ['reasoning.encrypted_content']);
    assert.ok(requests[0].max_output_tokens >= 1024 + 25000, 'room for the reasoning on top of the answer');
    assert.deepEqual(requests[0].tools[0].name, 'get_value');
    assert.deepEqual(
        requests[1].input.slice(1).map(i => i.type),
        ['reasoning', 'function_call', 'function_call_output'],
        'reasoning and call go back with the result',
    );
    assert.equal(requests[1].input[3].call_id, 'call1');
    assert.equal(steps.filter(s => s.level === 'warn').length, 2);
    assert.equal(
        steps.some(s => s.level === 'error'),
        false,
    );
    assert.equal(steps.find(s => s.title === 'Round 2 → answer').tokens.cacheRead, 16, 'cached input tokens');

    // the next question goes to the Responses API at once
    chatCalls = 0;
    requests.length = 0;
    assert.equal(await agent.ask('again?'), 'It is 42.');
    assert.equal(chatCalls, 0);
    assert.equal(requests.length, 2);
});

test('openai: a chosen reasoning effort is kept — tools refused with it go to the Responses API, not to "none"', async () => {
    const { agent, steps, ran } = toolAgent('effort-kept-model', { reasoningEffort: 'medium' });
    const sent = [];
    agent.openai.chat.completions.create = async req => {
        sent.push(req.reasoning_effort);
        // like gpt-6-luna: "none" would be taken, but the effort the user chose would be lost
        if (req.reasoning_effort !== 'none') {
            throw apiError(400, TOOLS_WITH_EFFORT);
        }
        return { choices: [{ message: { role: 'assistant', content: 'without reasoning' } }] };
    };
    const requests = responsesMock(agent);
    assert.equal(await agent.ask('value?'), 'It is 42.');
    assert.deepEqual(sent, ['medium']);
    assert.deepEqual(ran, ['get_value']);
    assert.deepEqual(requests[0].reasoning, { effort: 'medium' });
    assert.ok(requests[0].max_output_tokens >= 1024 + 25000);
    const retries = steps.filter(s => s.level === 'warn');
    assert.equal(retries.length, 1);
    assert.match(retries[0].title, /"medium" only over the Responses API/);

    // the next question goes to the Responses API at once
    sent.length = 0;
    requests.length = 0;
    assert.equal(await agent.ask('again?'), 'It is 42.');
    assert.deepEqual(sent, []);
    assert.equal(requests.length, 2);
});

test('openai: an answer that ran out of tokens is an error, not an empty answer', async () => {
    const { agent, steps } = toolAgent('incomplete-model', { reasoningEffort: 'high' });
    agent.openai.chat.completions.create = async () => {
        throw apiError(400, TOOLS_WITH_EFFORT);
    };
    let resp = {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', id: 'r1', encrypted_content: 'enc' }],
        output_text: '',
        usage: { input_tokens: 10, output_tokens: 26024 },
    };
    agent.openai.responses.create = async () => resp;
    await assert.rejects(agent.ask('value?'), /stopped without an answer \(max_output_tokens\)/);

    // cut off in the middle of the answer: given, with a warning
    resp = { ...resp, output_text: 'It is' };
    assert.equal(await agent.ask('value?'), 'It is');
    assert.ok(steps.some(s => s.level === 'warn' && /cut off \(max_output_tokens\)/.test(s.title)));

    // the same on Chat Completions (a reasoning model there, or any model with a tiny limit)
    const chat = toolAgent('length-model').agent;
    chat.openai.chat.completions.create = async () => ({
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
    });
    await assert.rejects(chat.ask('value?'), /stopped without an answer \(length\)/);
});

test('openai: other errors are not retried', async () => {
    const { agent } = toolAgent('broken-model', { reasoningEffort: 'low' });
    let calls = 0;
    agent.openai.chat.completions.create = async () => {
        calls++;
        throw apiError(401, 'Incorrect API key');
    };
    await assert.rejects(agent.ask('hi'), /Incorrect API key/);
    assert.equal(calls, 1);
});
