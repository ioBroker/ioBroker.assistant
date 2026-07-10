'use strict';
// Integration test: tool gating + per-device ACL enforcement (write-guard, read-guard, list filtering).
const test = require('node:test');
const assert = require('node:assert/strict');
const { deviceKey, deviceStateIds, isToolAllowed, ListCache, buildMcpTools } = require('../../build/lib/tools.js');

test('deviceKey = lexicographically smallest control state id', () => {
    assert.equal(deviceKey(['b', 'a', 'c']), 'a');
    assert.equal(deviceKey([]), '');
});

test('deviceStateIds collects control state ids', () => {
    assert.deepEqual(deviceStateIds({ controls: { p: { stateId: 'x' }, q: { stateId: 'y' }, r: {} } }), ['x', 'y']);
    assert.deepEqual(deviceStateIds({}), []);
});

test('isToolAllowed honours the access toggles', () => {
    const base = {
        allowWriteStates: false,
        allowObjectChange: false,
        readObjects: 'devices',
        allowReadLogs: false,
        allowWriteLogs: false,
        allowHistory: false,
        allowFiles: false,
        allowSystemInfo: true,
        deviceAcl: {},
    };
    assert.equal(isToolAllowed('get_states', base), true); // reading is always allowed
    assert.equal(isToolAllowed('set_state', base), false); // writing gated
    assert.equal(isToolAllowed('set_state', { ...base, allowWriteStates: true }), true);
    assert.equal(isToolAllowed('get_object', base), false); // needs readObjects === 'all'
    assert.equal(isToolAllowed('get_object', { ...base, readObjects: 'all' }), true);
    assert.equal(isToolAllowed('unknown_tool', base), false); // deny by default
});

test('ListCache serves within the TTL and refreshes after clear/expiry', async () => {
    let now = 1000;
    const cache = new ListCache(100, () => now);
    let calls = 0;
    const produce = async () => `v${++calls}`;
    assert.equal(await cache.run('k', produce), 'v1');
    assert.equal(await cache.run('k', produce), 'v1'); // cached
    now += 200; // past TTL
    assert.equal(await cache.run('k', produce), 'v2'); // refreshed
    cache.clear();
    assert.equal(await cache.run('k', produce), 'v3');
});

// ── Enforcement via a fake in-process MCP ───────────────────────────────────
const LIST_DEVICES = JSON.stringify({
    ok: true,
    data: {
        rooms: [
            {
                roomName: 'Room',
                devicesInRoom: [
                    {
                        deviceName: 'Light',
                        deviceType: 'light',
                        controls: { power: { stateId: 'dev.light.SET', writable: true, ioBrokerValueType: 'boolean' } },
                    },
                    {
                        deviceName: 'Lock',
                        deviceType: 'lock',
                        controls: { power: { stateId: 'dev.lock.SET', writable: true, ioBrokerValueType: 'boolean' } },
                    },
                    {
                        deviceName: 'Btn',
                        deviceType: 'button',
                        controls: { power: { stateId: 'dev.btn.PRESS', writable: true } },
                    },
                    {
                        deviceName: 'Secret',
                        deviceType: 'socket',
                        controls: { power: { stateId: 'dev.secret.SET', writable: true, ioBrokerValueType: 'boolean' } },
                    },
                ],
            },
        ],
    },
});

function fakeMcp() {
    return {
        async listTools() {
            return [
                { name: 'list_devices', description: '', inputSchema: {} },
                { name: 'get_states', description: '', inputSchema: {} },
                { name: 'set_state', description: '', inputSchema: {} },
            ];
        },
        async callTool(name, args) {
            if (name === 'list_devices') {
                return { text: LIST_DEVICES };
            }
            if (name === 'get_states') {
                return { text: JSON.stringify({ ok: true, data: { states: (args.ids || []).map(id => ({ id, value: 1 })) } }) };
            }
            if (name === 'set_state') {
                return { text: JSON.stringify({ ok: true, data: { id: args.id, value: args.value } }) };
            }
            return { text: '{}' };
        },
    };
}

const access = {
    allowWriteStates: true,
    allowObjectChange: false,
    readObjects: 'devices',
    allowReadLogs: false,
    allowWriteLogs: false,
    allowHistory: false,
    allowFiles: false,
    allowSystemInfo: true,
    // Secret device is read-disabled (keyed by its primary state id).
    deviceAcl: { 'dev.secret.SET': { read: false, write: true } },
};

test('list_devices drops buttons and read-disabled devices for the LLM', async () => {
    const { tools } = await buildMcpTools(fakeMcp(), access);
    const ld = tools.find(t => t.name === 'list_devices');
    const parsed = JSON.parse(await ld.run({}));
    const names = parsed.data.rooms[0].devicesInRoom.map(d => d.deviceName).sort();
    assert.deepEqual(names, ['Light', 'Lock']); // Btn (button) + Secret (read off) removed
});

test('set_state is blocked for a lock (default write-off) but allowed for a normal device', async () => {
    const { tools } = await buildMcpTools(fakeMcp(), access);
    const setState = tools.find(t => t.name === 'set_state');
    const lockRes = JSON.parse(await setState.run({ id: 'dev.lock.SET', value: true }));
    assert.equal(lockRes.ok, false); // lock is read-only by default
    const lightRes = JSON.parse(await setState.run({ id: 'dev.light.SET', value: true }));
    assert.equal(lightRes.ok, true);
});

test('get_states filters out values of read-disabled devices', async () => {
    const { tools } = await buildMcpTools(fakeMcp(), access);
    const getStates = tools.find(t => t.name === 'get_states');
    const res = JSON.parse(await getStates.run({ ids: ['dev.light.SET', 'dev.secret.SET'] }));
    assert.deepEqual(
        res.data.states.map(s => s.id),
        ['dev.light.SET'], // dev.secret.SET removed
    );
});
