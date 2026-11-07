'use strict';
// Integration test: pictures and videos that come with an `ask` (Telegram photos/videos).
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MAX_IMAGES,
    MAX_IMAGE_BASE64,
    attachmentNote,
    historyText,
    imageOnlyQuestion,
    isVideoError,
    noVisionText,
    parseAskImages,
    parseAskVideo,
    redactImages,
    sniffImageType,
    videoNotSupportedText,
} = require('../../build/lib/media.js');
const { anthropicUserContent, openAiUserContent } = require('../../build/lib/llm.js');

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(100, 1),
]).toString('base64');
const GIF = Buffer.from('GIF89a................').toString('base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(40)]).toString(
    'base64',
);

test('the picture type comes from the content', () => {
    assert.equal(sniffImageType(Buffer.from(JPEG, 'base64')), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.from(PNG, 'base64')), 'image/png');
    assert.equal(sniffImageType(Buffer.from(GIF, 'base64')), 'image/gif');
    assert.equal(sniffImageType(Buffer.from(WEBP, 'base64')), 'image/webp');
    assert.equal(sniffImageType(Buffer.from('%PDF-1.7 ....')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test('pictures of an ask: list, single object, data URL; the declared type is ignored', () => {
    assert.deepEqual(parseAskImages(undefined), { images: [] });
    assert.deepEqual(parseAskImages([]), { images: [] });

    const { images, error } = parseAskImages([
        { data: JPEG, mimeType: 'image/png' },
        { data: `data:image/png;base64,${PNG}` },
    ]);
    assert.equal(error, undefined);
    assert.deepEqual(
        images.map(i => i.mimeType),
        ['image/jpeg', 'image/png'],
    );
    assert.equal(images[1].data, PNG, 'data URL prefix removed');

    assert.equal(parseAskImages({ data: WEBP }).images[0].mimeType, 'image/webp');
    assert.equal(parseAskImages(GIF).images[0].mimeType, 'image/gif');
});

test('pictures are refused: too many, too big, no data, not a picture', () => {
    const many = Array.from({ length: MAX_IMAGES + 1 }, () => ({ data: JPEG }));
    assert.match(parseAskImages(many).error, /too many pictures/);
    assert.equal(parseAskImages(many).images.length, 0);

    const big = `/9j/${'A'.repeat(MAX_IMAGE_BASE64)}`;
    assert.match(parseAskImages([{ data: big }]).error, /too big/);

    assert.match(parseAskImages([{ mimeType: 'image/jpeg' }]).error, /without data/);
    assert.match(parseAskImages([{ data: Buffer.from('%PDF-1.7 hello').toString('base64') }]).error, /not a JPEG/);
    // one bad picture refuses the whole request, not only itself
    assert.equal(parseAskImages([{ data: JPEG }, { data: 'aGVsbG8=' }]).images.length, 0);
});

test('a video only as a reference into the file storage, never as content', () => {
    assert.equal(parseAskVideo(undefined), null);
    const ref = parseAskVideo({
        adapter: 'telegram.0',
        path: '/assistant/video_1.mp4',
        mimeType: 'video/mp4',
        durationSec: 12,
        size: 3_400_000,
    });
    assert.ok(!isVideoError(ref));
    assert.deepEqual(ref, {
        adapter: 'telegram.0',
        path: 'assistant/video_1.mp4',
        mimeType: 'video/mp4',
        durationSec: 12,
        size: 3_400_000,
        error: undefined,
    });

    const content = parseAskVideo({ data: 'AAAA', mimeType: 'video/mp4' });
    assert.ok(isVideoError(content));
    assert.match(content.error, /not sent as content/);

    assert.ok(isVideoError(parseAskVideo('AAAA')));
    assert.ok(isVideoError(parseAskVideo({ adapter: 'telegram.0' })));
    // the sender could not store it (bigger than 20 MB): still a video, with the reason
    const failed = parseAskVideo({ error: 'too big to download (52 MB)', durationSec: 300 });
    assert.ok(!isVideoError(failed));
    assert.equal(failed.error, 'too big to download (52 MB)');
});

test('the user turn for OpenAI and Anthropic', () => {
    const images = [{ data: JPEG, mimeType: 'image/jpeg' }];
    assert.equal(openAiUserContent('Hallo'), 'Hallo');
    assert.equal(anthropicUserContent('Hallo', []), 'Hallo');

    assert.deepEqual(openAiUserContent('Was ist das?', images), [
        { type: 'text', text: 'Was ist das?' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
    ]);
    // Anthropic: pictures first, then the text
    assert.deepEqual(anthropicUserContent('Was ist das?', images), [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
        { type: 'text', text: 'Was ist das?' },
    ]);
});

test('the trace and the debug log get a note instead of the base64', () => {
    const images = [{ data: JPEG, mimeType: 'image/jpeg' }];
    const sent = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: openAiUserContent('Was ist das?', images) },
        { role: 'user', content: anthropicUserContent('Und das?', images) },
    ];
    const red = redactImages(sent);
    const text = JSON.stringify(red);
    assert.ok(!text.includes(JPEG), 'no base64 left');
    assert.equal(red[1].content[1].image_url.url, '<image/jpeg, 0 KB>');
    assert.equal(red[2].content[0].source.data, '<image/jpeg, 0 KB>');
    assert.equal(red[2].content[1].text, 'Und das?');
    // the original is untouched - it still goes to the model
    assert.equal(sent[1].content[1].image_url.url, `data:image/jpeg;base64,${JPEG}`);
    // a normal URL stays
    const url = [{ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }];
    assert.deepEqual(redactImages(url), url);
});

test('texts and markers', () => {
    assert.equal(imageOnlyQuestion('de'), 'Was ist auf diesem Bild?');
    assert.equal(imageOnlyQuestion('ru', 3), 'Что на этих картинках?');
    assert.equal(imageOnlyQuestion('fr'), 'What is in this picture?');
    assert.match(videoNotSupportedText('de'), /Videos/);
    assert.match(noVisionText('ru'), /облачной/);

    assert.equal(attachmentNote(0, false), '');
    assert.equal(attachmentNote(1, false), '(A picture is attached.)');
    assert.match(attachmentNote(2, true), /^\(2 pictures are attached\. The user also sent a video/);
    assert.match(attachmentNote(0, true), /cannot watch/);

    assert.equal(historyText('Was ist das?', 0, false), 'Was ist das?');
    assert.equal(historyText('Was ist das?', 1, false), '[picture] Was ist das?');
    assert.equal(historyText('Und das?', 2, true), '[2 pictures] [video] Und das?');
    assert.equal(historyText('', 0, true), '[video]');
});
