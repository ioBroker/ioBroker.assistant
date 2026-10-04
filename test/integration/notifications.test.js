'use strict';
// Integration test: system notifications — severity handling, text cleanup, notification-manager payloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseSeverity,
    toneFor,
    bypassesDnd,
    cleanupNotificationText,
    translated,
    flattenNotification,
} = require('../../build/lib/notifications.js');

test('parseSeverity accepts ioBroker severities plus our direct, and falls back to notify', () => {
    assert.equal(parseSeverity('alert'), 'alert');
    assert.equal(parseSeverity('INFO'), 'info');
    assert.equal(parseSeverity(' direct '), 'direct');
    assert.equal(parseSeverity('notify'), 'notify');
    assert.equal(parseSeverity('whatever'), 'notify');
    assert.equal(parseSeverity(undefined), 'notify');
    assert.equal(parseSeverity('', 'info'), 'info', 'the caller can choose the fallback');
});

test('every severity has a tone except direct, which is spoken verbatim', () => {
    assert.ok(toneFor('alert').length > 10);
    assert.ok(toneFor('notify').length > 10);
    assert.ok(toneFor('info').length > 10);
    assert.equal(toneFor('direct'), '');
    assert.notEqual(toneFor('alert'), toneFor('info'));
});

test('only an alert overrides Do-Not-Disturb', () => {
    assert.equal(bypassesDnd('alert'), true);
    assert.equal(bypassesDnd('notify'), false);
    assert.equal(bypassesDnd('info'), false);
    assert.equal(bypassesDnd('direct'), false);
});

test('cleanupNotificationText drops the origin prefixes and folds the lines', () => {
    assert.equal(
        cleanupNotificationText('system.host.pi: admin.0: Cannot read file settings.json'),
        'Cannot read file settings.json',
    );
    assert.equal(cleanupNotificationText('javascript.0: script stopped'), 'script stopped');
    // Every line loses its own prefix, not just the first: the instance id is noise when it repeats per
    // line, and where it carries information (one block per instance) flattenNotification adds it back.
    assert.equal(
        cleanupNotificationText('system.host.raspi-3:\n  hm-rpc.1: timeout\n\n  hm-rpc.1: reconnected\n'),
        'timeout reconnected',
    );
    assert.equal(cleanupNotificationText('  spaced   out    text  '), 'spaced out text');
    assert.equal(cleanupNotificationText(''), '');
    assert.equal(cleanupNotificationText(null), '');
    assert.equal(cleanupNotificationText(42), '42');
    assert.equal(
        cleanupNotificationText('Version 1.2.3 of admin.0 is available'),
        'Version 1.2.3 of admin.0 is available',
        'an id inside the sentence is content, not a prefix',
    );
});

test('translated picks the language, then English, then whatever is there', () => {
    assert.equal(translated('plain'), 'plain');
    assert.equal(translated({ en: 'Updates', de: 'Aktualisierungen' }, 'de'), 'Aktualisierungen');
    assert.equal(translated({ en: 'Updates', de: 'Aktualisierungen' }, 'ru'), 'Updates');
    assert.equal(translated({ fr: 'Mises à jour' }, 'ru'), 'Mises à jour');
    assert.equal(translated(undefined), '');
});

test('flattenNotification turns a notification-manager payload into one spoken line', () => {
    const flat = flattenNotification(
        {
            host: 'system.host.pi',
            category: {
                name: { en: 'Package updates', de: 'Paket-Updates' },
                description: { en: 'Some packages can be updated', de: 'Pakete können aktualisiert werden' },
                severity: 'info',
                instances: {
                    'admin.0': { messages: [{ message: 'admin.0: update to 8.1.0 available', ts: 1 }] },
                },
            },
        },
        'de',
    );
    assert.equal(flat.severity, 'info');
    assert.equal(flat.category, 'Paket-Updates');
    assert.equal(flat.text, 'Paket-Updates: admin.0: update to 8.1.0 available');
});

test('flattenNotification keeps only the newest messages and names every instance', () => {
    const flat = flattenNotification({
        category: {
            name: 'Host errors',
            severity: 'alert',
            instances: {
                'hm-rpc.0': {
                    messages: [{ message: 'one' }, { message: 'two' }, { message: 'three' }, { message: 'four' }],
                },
                'shelly.0': { messages: [{ message: 'offline' }] },
            },
        },
    });
    assert.equal(flat.severity, 'alert');
    assert.equal(flat.text, 'Host errors: hm-rpc.0: two three four — shelly.0: offline');
});

test('flattenNotification falls back to the description and survives junk', () => {
    const noMessages = flattenNotification({
        category: { name: 'Disk space', description: 'The disk is nearly full', severity: 'alert', instances: {} },
    });
    assert.equal(noMessages.text, 'Disk space: The disk is nearly full');

    for (const junk of [undefined, null, {}, 'a string', 42, { category: {} }, { category: { instances: null } }]) {
        const flat = flattenNotification(junk);
        assert.equal(flat.text, '', `nothing to speak for ${JSON.stringify(junk)}`);
        assert.equal(flat.severity, 'notify', 'and a safe middle severity');
    }
});
