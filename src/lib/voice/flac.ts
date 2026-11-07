/**
 * A minimal FLAC encoder for the spoken replies of ESPHome satellites.
 *
 * Since ESPHome 2026.10 the media player of a satellite is built only with the decoders its own pipelines use —
 * typically FLAC (what Home Assistant transcodes to) and MP3 (the wake sound). A WAV reply then does not play at
 * all. FLAC can be written without a codec library: every subframe here is VERBATIM, i.e. the samples as they are.
 * That gives files as large as a WAV — irrelevant on the LAN between the adapter and the speaker — but a stream every
 * FLAC decoder must read, and the cheapest one for the ESP to decode.
 *
 * Layout (https://www.rfc-editor.org/rfc/rfc9639): `fLaC`, one STREAMINFO block, then frames of up to
 * {@link BLOCK_SIZE} samples per channel, each with header + CRC-8, one subframe per channel, and a CRC-16.
 */
import { createHash } from 'node:crypto';

/** Samples per channel in one frame — the common libFLAC default. */
const BLOCK_SIZE = 4096;
/** FLAC forbids blocks below 16 samples (except as the last one); a shorter clip is padded with silence. */
const MIN_BLOCK = 16;

/** Frame-header sample-rate codes (RFC 9639 9.1.2). Others are written out after the header. */
const RATE_CODES: Record<number, number> = {
    88200: 1,
    176400: 2,
    192000: 3,
    8000: 4,
    16000: 5,
    22050: 6,
    24000: 7,
    32000: 8,
    44100: 9,
    48000: 10,
    96000: 11,
};

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
    let c8 = i;
    let c16 = i << 8;
    for (let b = 0; b < 8; b++) {
        c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
        c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
    }
    CRC8[i] = c8;
    CRC16[i] = c16;
}

function crc8(buf: Uint8Array, end: number): number {
    let crc = 0;
    for (let i = 0; i < end; i++) {
        crc = CRC8[crc ^ buf[i]];
    }
    return crc;
}

function crc16(buf: Uint8Array, end: number): number {
    let crc = 0;
    for (let i = 0; i < end; i++) {
        crc = ((crc << 8) & 0xffff) ^ CRC16[(crc >> 8) ^ buf[i]];
    }
    return crc;
}

/** The frame number in FLAC's UTF-8-like coding (up to 31 bits). */
function codedNumber(n: number): number[] {
    if (n < 0x80) {
        return [n];
    }
    const bytes: number[] = [];
    let rest = n;
    // Continuation bytes carry 6 bits each; the lead byte has room for (6 - count) bits.
    while (rest >= 1 << (6 - bytes.length)) {
        bytes.unshift(0x80 | (rest & 0x3f));
        rest = Math.floor(rest / 64);
    }
    const count = bytes.length + 1;
    const lead = (0xff << (8 - count)) & 0xff;
    return [lead | rest, ...bytes];
}

/** Rate code for the frame header, plus the bytes that follow the header when the rate is not one of the codes. */
function rateField(sampleRate: number): { code: number; extra: number[] } {
    const code = RATE_CODES[sampleRate];
    if (code !== undefined) {
        return { code, extra: [] };
    }
    if (sampleRate <= 0xffff) {
        return { code: 13, extra: [sampleRate >> 8, sampleRate & 0xff] }; // 16-bit Hz
    }
    if (sampleRate % 10 === 0 && sampleRate / 10 <= 0xffff) {
        const tens = sampleRate / 10;
        return { code: 14, extra: [tens >> 8, tens & 0xff] }; // 16-bit tens of Hz
    }
    return { code: 0, extra: [] }; // see STREAMINFO
}

/**
 * Encode 16-bit little-endian PCM (interleaved when `channels` is 2) as a FLAC file.
 *
 * @param pcm s16le samples
 * @param sampleRate in Hz (1…655350)
 * @param channels 1 or 2
 */
export function encodeFlac(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
    if (channels < 1 || channels > 8 || !Number.isInteger(channels)) {
        throw new Error(`FLAC: ${channels} channels are not supported`);
    }
    if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 655350) {
        throw new Error(`FLAC: sample rate ${sampleRate} is not supported`);
    }
    const frameBytes = 2 * channels;
    let samples = Math.floor(pcm.length / frameBytes);
    let data = pcm.subarray(0, samples * frameBytes);
    if (samples < MIN_BLOCK) {
        data = Buffer.concat([data, Buffer.alloc((MIN_BLOCK - samples) * frameBytes)]);
        samples = MIN_BLOCK;
    }

    const rate = rateField(sampleRate);
    const frames: Buffer[] = [];
    let minFrame = Number.MAX_SAFE_INTEGER;
    let maxFrame = 0;
    for (let start = 0, index = 0; start < samples; start += BLOCK_SIZE, index++) {
        const count = Math.min(BLOCK_SIZE, samples - start);
        const header = [
            0xff,
            0xf8, // sync code, fixed block size
            (0b0111 << 4) | rate.code, // block size: 16 bit (count − 1) after the coded number
            ((channels - 1) << 4) | (0b100 << 1), // independent channels, 16 bits per sample
            ...codedNumber(index),
            (count - 1) >> 8,
            (count - 1) & 0xff,
            ...rate.extra,
        ];
        const size = header.length + 1 + channels * (1 + count * 2) + 2;
        const frame = Buffer.alloc(size);
        frame.set(header, 0);
        let pos = header.length;
        frame[pos] = crc8(frame, pos);
        pos++;
        for (let ch = 0; ch < channels; ch++) {
            frame[pos++] = 0x02; // subframe header: VERBATIM, no wasted bits
            for (let i = 0; i < count; i++) {
                frame.writeInt16BE(data.readInt16LE(((start + i) * channels + ch) * 2), pos);
                pos += 2;
            }
        }
        frame.writeUInt16BE(crc16(frame, pos), pos);
        frames.push(frame);
        minFrame = Math.min(minFrame, size);
        maxFrame = Math.max(maxFrame, size);
    }

    const block = Math.min(BLOCK_SIZE, samples);
    const info = Buffer.alloc(4 + 34);
    info[0] = 0x80; // last metadata block, type 0 = STREAMINFO
    info.writeUIntBE(34, 1, 3);
    info.writeUInt16BE(block, 4); // min block size (the last block may be shorter)
    info.writeUInt16BE(block, 6); // max block size
    info.writeUIntBE(minFrame, 8, 3);
    info.writeUIntBE(maxFrame, 11, 3);
    // 20 bits sample rate, 3 bits channels − 1, 5 bits bits-per-sample − 1, 36 bits total samples
    const packed =
        (BigInt(sampleRate) << 44n) | (BigInt(channels - 1) << 41n) | (BigInt(16 - 1) << 36n) | BigInt(samples);
    info.writeBigUInt64BE(packed, 14);
    // MD5 of the decoded audio: the samples as interleaved little-endian 16-bit words — exactly `data`.
    createHash('md5').update(data).digest().copy(info, 22);

    return Buffer.concat([Buffer.from('fLaC', 'latin1'), info, ...frames]);
}
