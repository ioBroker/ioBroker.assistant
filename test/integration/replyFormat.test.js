'use strict';
// Spoken replies for ESPHome satellites in the format their media player takes: the FLAC encoder, the resampler,
// the choice from `supported_formats`, and the entity ids current firmware no longer sends.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { encodeFlac } = require('../../build/lib/voice/flac.js');
const { chooseReplyFormat, encodeReply, resamplePcm, monoToStereo } = require('../../build/lib/voice/replyFormat.js');
const { entityObjectId, esphomeObjectId, EntityRegistry } = require('../../build/lib/voice/esphomeEntities.js');
const { pb } = require('../../build/lib/voice/esphomeProto.js');

/** s16le mono sine. */
function sine(freq, rate, ms, amplitude = 12000) {
    const n = Math.round((rate * ms) / 1000);
    const buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
    }
    return buf;
}

function crc8(buf) {
    let crc = 0;
    for (const byte of buf) {
        crc ^= byte;
        for (let b = 0; b < 8; b++) {
            crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
    }
    return crc;
}

function crc16(buf) {
    let crc = 0;
    for (const byte of buf) {
        crc ^= byte << 8;
        for (let b = 0; b < 8; b++) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

/** Length of a FLAC UTF-8-coded number from its lead byte. */
function codedLength(lead) {
    let n = 0;
    while (lead & (0x80 >> n)) {
        n++;
    }
    return n === 0 ? 1 : n;
}

/**
 * Decode what encodeFlac writes (verbatim subframes, 16 bit), checking every CRC — written independently of the
 * encoder, bit by bit, so a shared mistake in the CRC tables would not hide.
 */
function decodeVerbatimFlac(file) {
    assert.equal(file.subarray(0, 4).toString('latin1'), 'fLaC');
    assert.equal(file[4], 0x80, 'one metadata block, STREAMINFO, marked last');
    assert.equal(file.readUIntBE(5, 3), 34);
    const info = file.subarray(8, 42);
    const packed = info.readBigUInt64BE(10);
    const sampleRate = Number(packed >> 44n);
    const channels = Number((packed >> 41n) & 7n) + 1;
    const bits = Number((packed >> 36n) & 31n) + 1;
    const total = Number(packed & 0xfffffffffn);
    const md5 = info.subarray(18, 34);
    let pos = 42;
    const out = [];
    let frames = 0;
    while (pos < file.length) {
        const start = pos;
        assert.equal(file.readUInt16BE(pos), 0xfff8, `sync code of frame ${frames}`);
        const blockCode = file[pos + 2] >> 4;
        const rateCode = file[pos + 2] & 15;
        assert.equal(blockCode, 7, 'block size follows as 16 bit');
        assert.equal(file[pos + 3] >> 4, channels - 1, 'independent channels');
        assert.equal((file[pos + 3] >> 1) & 7, 4, '16 bits per sample');
        pos += 4;
        pos += codedLength(file[pos]);
        const count = file.readUInt16BE(pos) + 1;
        pos += 2;
        if (rateCode === 13 || rateCode === 14) {
            pos += 2;
        }
        assert.equal(file[pos], crc8(file.subarray(start, pos)), `header CRC of frame ${frames}`);
        pos++;
        const chans = [];
        for (let ch = 0; ch < channels; ch++) {
            assert.equal(file[pos], 0x02, 'VERBATIM subframe');
            pos++;
            const samples = [];
            for (let i = 0; i < count; i++) {
                samples.push(file.readInt16BE(pos));
                pos += 2;
            }
            chans.push(samples);
        }
        assert.equal(file.readUInt16BE(pos), crc16(file.subarray(start, pos)), `frame CRC of frame ${frames}`);
        pos += 2;
        for (let i = 0; i < count; i++) {
            for (let ch = 0; ch < channels; ch++) {
                out.push(chans[ch][i]);
            }
        }
        frames++;
    }
    const pcm = Buffer.alloc(out.length * 2);
    out.forEach((v, i) => pcm.writeInt16LE(v, i * 2));
    return { sampleRate, channels, bits, total, md5, pcm, frames };
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// ── FLAC ────────────────────────────────────────────────────────────────────

test('FLAC: a mono clip comes back sample for sample, with valid CRCs and MD5', () => {
    const pcm = sine(440, 24000, 1000); // 24 000 samples = 5 full frames + 1 short one
    const flac = encodeFlac(pcm, 24000, 1);
    const decoded = decodeVerbatimFlac(flac);
    assert.equal(decoded.sampleRate, 24000);
    assert.equal(decoded.channels, 1);
    assert.equal(decoded.bits, 16);
    assert.equal(decoded.total, 24000);
    assert.equal(decoded.frames, 6);
    assert.ok(decoded.pcm.equals(pcm), 'samples unchanged');
    assert.ok(decoded.md5.equals(crypto.createHash('md5').update(pcm).digest()), 'MD5 of the audio');
});

test('FLAC: stereo and sample rates without a header code', () => {
    const pcm = monoToStereo(sine(300, 11025, 500));
    const decoded = decodeVerbatimFlac(encodeFlac(pcm, 11025, 2));
    assert.equal(decoded.channels, 2);
    assert.equal(decoded.sampleRate, 11025);
    assert.ok(decoded.pcm.equals(pcm));
});

test('FLAC: more than 127 frames need a two-byte frame number', () => {
    const pcm = sine(200, 48000, 12000); // 576 000 samples → 141 frames
    const decoded = decodeVerbatimFlac(encodeFlac(pcm, 48000, 1));
    assert.equal(decoded.frames, 141);
    assert.ok(decoded.pcm.equals(pcm));
});

test('FLAC: a clip shorter than the minimum block is padded with silence', () => {
    const decoded = decodeVerbatimFlac(encodeFlac(Buffer.from([1, 0, 2, 0]), 16000, 1));
    assert.equal(decoded.total, 16);
    assert.deepEqual([...decoded.pcm.subarray(0, 6)], [1, 0, 2, 0, 0, 0]);
});

test('FLAC: ffmpeg decodes it to the same samples', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
    const pcm = sine(523, 22050, 700);
    const res = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-f', 'flac', '-i', 'pipe:0', '-f', 's16le', '-'],
        {
            input: encodeFlac(pcm, 22050, 1),
        },
    );
    assert.equal(res.status, 0, String(res.stderr));
    assert.ok(Buffer.from(res.stdout).equals(pcm), 'ffmpeg reads the same audio back');
});

// ── resampling ──────────────────────────────────────────────────────────────

/** Rising zero crossings — a frequency estimate that does not care about the filter's phase. */
function zeroCrossings(pcm) {
    let n = 0;
    for (let i = 2; i < pcm.length; i += 2) {
        if (pcm.readInt16LE(i - 2) < 0 && pcm.readInt16LE(i) >= 0) {
            n++;
        }
    }
    return n;
}

function rmsOf(pcm, from = 0, to = pcm.length >> 1) {
    let sum = 0;
    for (let i = from; i < to; i++) {
        sum += pcm.readInt16LE(i * 2) ** 2;
    }
    return Math.sqrt(sum / (to - from));
}

test('resampling keeps length, pitch and level', () => {
    const pcm = sine(440, 24000, 1000);
    for (const to of [48000, 16000, 44100]) {
        const out = resamplePcm(pcm, 24000, to);
        assert.equal(out.length / 2, to, `${to}: one second stays one second`);
        assert.ok(Math.abs(zeroCrossings(out) - 440) <= 1, `${to}: still 440 Hz (${zeroCrossings(out)})`);
        const level = rmsOf(out, to / 10, to - to / 10) / rmsOf(pcm, 2400, 21600);
        assert.ok(level > 0.97 && level < 1.03, `${to}: level ${level.toFixed(3)}`);
    }
    assert.equal(resamplePcm(pcm, 24000, 24000), pcm, 'same rate: untouched');
});

test('downsampling filters what the lower rate cannot carry instead of folding it back', () => {
    // 10 kHz at 24 kHz: above the 8 kHz Nyquist of 16 kHz. Linear interpolation would turn it into 6 kHz.
    const out = resamplePcm(sine(10000, 24000, 500), 24000, 16000);
    assert.ok(rmsOf(out, 800, 7200) < 300, `residue RMS ${rmsOf(out, 800, 7200).toFixed(0)} of 8485`);
});

// ── choosing the format ─────────────────────────────────────────────────────

const fmt = (format, sampleRate, channels, purpose = 'announcement') => ({
    format,
    sampleRate,
    channels,
    purpose,
    sampleBytes: 2,
});

test('a device that lists no formats keeps getting WAV at the TTS rate', () => {
    assert.deepEqual(chooseReplyFormat([], true), { codec: 'wav', sampleRate: 0, channels: 1, source: '' });
});

test('the announcement format wins, at its rate and channel count', () => {
    const f = chooseReplyFormat([fmt('mp3', 44100, 2, 'default'), fmt('flac', 48000, 1)], true);
    assert.equal(f.codec, 'flac');
    assert.equal(f.sampleRate, 48000);
    assert.equal(f.channels, 1);
});

test('MP3/Opus only with an external encoder, otherwise a native format the device also lists', () => {
    assert.equal(chooseReplyFormat([fmt('mp3', 48000, 1)], true).codec, 'mp3');
    const without = chooseReplyFormat([fmt('mp3', 48000, 1), fmt('flac', 48000, 1, 'default')], false);
    assert.equal(without.codec, 'flac');
    assert.equal(chooseReplyFormat([fmt('opus', 48000, 1)], false).codec, 'wav', 'nothing usable: WAV as before');
});

test('our own codecs before ffmpeg ones, also within the announcement purpose', () => {
    assert.equal(chooseReplyFormat([fmt('mp3', 48000, 1), fmt('FLAC', 48000, 1)], true).codec, 'flac');
});

test('encodeReply: FLAC at the device rate, WAV as before', async () => {
    const pcm = sine(440, 24000, 200);
    const flac = await encodeReply(pcm, 24000, { codec: 'flac', sampleRate: 48000, channels: 2, source: 'x' });
    assert.equal(flac.contentType, 'audio/flac');
    const decoded = decodeVerbatimFlac(flac.body);
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.channels, 2);
    assert.equal(decoded.total, 9600);

    const wav = await encodeReply(pcm, 24000, { codec: 'wav', sampleRate: 0, channels: 1, source: '' });
    assert.equal(wav.contentType, 'audio/wav');
    assert.equal(wav.body.readUInt32LE(24), 24000, 'WAV keeps the TTS rate');
    assert.ok(wav.body.subarray(44).equals(pcm));

    await assert.rejects(
        encodeReply(pcm, 24000, { codec: 'mp3', sampleRate: 48000, channels: 1, source: 'x' }),
        /no encoder/,
    );
    const mp3 = await encodeReply(pcm, 24000, { codec: 'mp3', sampleRate: 48000, channels: 1, source: 'x' }, async () =>
        Buffer.from('ID3'),
    );
    assert.equal(mp3.contentType, 'audio/mpeg');
});

// ── entity ids without object_id ────────────────────────────────────────────

test('ESPHome object ids are derived exactly as the firmware does', () => {
    assert.equal(esphomeObjectId('Mic Gain'), 'mic_gain');
    assert.equal(esphomeObjectId('Wake Word 1 Sensitivity'), 'wake_word_1_sensitivity');
    assert.equal(esphomeObjectId('LED (Ring)'), 'led__ring_');
});

test('an entity id comes from the device, else from the name, else from kind and key', () => {
    assert.equal(entityObjectId('mic_volume', 'Mic Volume', 'number', 1), 'mic_volume', 'sent by older firmware');
    assert.equal(entityObjectId('', 'Mic Volume', 'number', 1), 'mic_volume', 'the same id as before');
    assert.equal(entityObjectId('', 'Громкость микрофона', 'number', 1), 'громкость_микрофона', 'letters stay');
    assert.equal(entityObjectId('', 'Lautstärke', 'number', 1), 'lautstärke');
    assert.equal(entityObjectId('', '', 'mediaPlayer', 0x2a), 'media_player_2a');
    assert.equal(entityObjectId('', '!!!', 'switch', 7), 'switch_7');
});

test('the registry names entities without object_id, and one without a name after the device', () => {
    const registry = new EntityRegistry();
    const sw = new pb.ListEntitiesSwitchResponse();
    sw.setKey(1);
    sw.setName('Thinking Sound');
    registry.addFromAnnouncement('ListEntitiesSwitchResponse', sw, 'Gast Satellite');
    const player = new pb.ListEntitiesMediaPlayerResponse();
    player.setKey(2);
    const format = new pb.MediaPlayerSupportedFormat();
    format.setFormat('flac');
    format.setSampleRate(48000);
    format.setNumChannels(1);
    format.setPurpose(1);
    player.setSupportedFormatsList([format]);
    registry.addFromAnnouncement('ListEntitiesMediaPlayerResponse', player, 'Gast Satellite');

    assert.deepEqual(
        registry.list().map(e => e.objectId),
        ['thinking_sound', 'gast_satellite'],
    );
    const media = registry.get('gast_satellite');
    assert.equal(media.name, 'Gast Satellite');
    assert.deepEqual(media.formats, [
        { format: 'flac', sampleRate: 48000, channels: 1, purpose: 'announcement', sampleBytes: 0 },
    ]);
    assert.ok(registry.command('thinking_sound', true), 'writable under the derived id');
});
