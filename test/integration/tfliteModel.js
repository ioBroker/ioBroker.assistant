'use strict';
// Test helper: builds TFLite flatbuffers with just the parts the adapter reads — the main graph's first
// input and output tensor (shape, type, quantization). No operators or weights, so they would not run,
// but their structure is what the device checks before it loads a model.

const FLOAT32 = 0;
const UINT8 = 3;
const INT8 = 9;

/**
 * Serialize a tree of flatbuffer nodes front to back: every child is written after the field that points
 * at it, so all offsets are positive like in a real file.
 *
 * Nodes: `{ table: [field, …] }` (a field is `undefined`, `{ u8 }`, `{ i32 }` or a node), `{ tables: [node, …] }`,
 * `{ ints: [] }`, `{ floats: [] }`, `{ longs: [] }`, `{ str }`.
 */
function serialize(root, capacity) {
    const buf = Buffer.alloc(capacity);
    let pos = 8;
    buf.write('TFL3', 4, 'latin1');
    const align = () => {
        pos = (pos + 7) & ~7;
    };
    const emit = node => {
        align();
        const start = pos;
        if (node.table) {
            const fields = node.table;
            const vtable = start;
            buf.writeUInt16LE(4 + 2 * fields.length, vtable);
            buf.writeUInt16LE(4 + 4 * fields.length, vtable + 2);
            pos = vtable + 4 + 2 * fields.length;
            align();
            const table = pos;
            buf.writeInt32LE(table - vtable, table);
            pos = table + 4 + 4 * fields.length;
            const children = [];
            fields.forEach((f, i) => {
                const at = table + 4 + 4 * i;
                if (f === undefined) {
                    return;
                }
                buf.writeUInt16LE(at - table, vtable + 4 + 2 * i);
                if ('u8' in f) {
                    buf.writeUInt8(f.u8, at);
                } else if ('i32' in f) {
                    buf.writeInt32LE(f.i32, at);
                } else {
                    children.push([at, f]);
                }
            });
            for (const [at, child] of children) {
                buf.writeUInt32LE(emit(child) - at, at);
            }
            return table;
        }
        if (node.tables) {
            buf.writeUInt32LE(node.tables.length, start);
            pos = start + 4 + 4 * node.tables.length;
            node.tables.forEach((child, k) => {
                const at = start + 4 + 4 * k;
                buf.writeUInt32LE(emit(child) - at, at);
            });
            return start;
        }
        if (node.str !== undefined) {
            const bytes = Buffer.from(node.str);
            buf.writeUInt32LE(bytes.length, start);
            bytes.copy(buf, start + 4);
            pos = start + 4 + bytes.length + 1;
            return start;
        }
        const [list, size, write] = node.ints
            ? [node.ints, 4, (v, at) => buf.writeInt32LE(v, at)]
            : node.floats
              ? [node.floats, 4, (v, at) => buf.writeFloatLE(v, at)]
              : [node.longs, 8, (v, at) => buf.writeBigInt64LE(BigInt(v), at)];
        buf.writeUInt32LE(list.length, start);
        list.forEach((v, k) => write(v, start + 4 + size * k));
        pos = start + 4 + size * list.length;
        return start;
    };
    buf.writeUInt32LE(emit(root), 0);
    return buf.subarray(0, pos);
}

function tensor(name, { shape, type, scale, zeroPoint = 0 }) {
    // Field order of the schema's `Tensor`: shape, type, buffer, name, quantization.
    return {
        table: [
            { ints: shape },
            type === FLOAT32 ? undefined : { u8: type }, // flatbuffers leave out the default
            { i32: 0 },
            { str: name },
            scale === undefined ? undefined : { table: [undefined, undefined, { floats: [scale] }, { longs: [zeroPoint] }] },
        ],
    };
}

/**
 * A TFLite model whose main graph has one input and one output tensor.
 *
 * @param {{input: object, output: object, description?: string}} spec tensors as `{shape, type, scale?}`
 */
function tfliteModel({ input, output, description = 'MLIR Converted.' }) {
    const subgraph = {
        table: [
            { tables: [tensor('input', input), tensor('output', output)] },
            { ints: [0] },
            { ints: [1] },
            { tables: [] },
            { str: 'main' },
        ],
    };
    // `Model`: version, operator_codes, subgraphs, description.
    const model = { table: [{ i32: 3 }, { tables: [] }, { tables: [subgraph] }, { str: description }] };
    return serialize(model, 4096 + Buffer.byteLength(description));
}

/**
 * A model shaped like an official microWakeWord v2 model: input `[1, 3, 40]` int8, output `[1, 1]` uint8,
 * both quantized. `fill`/`size` vary its bytes (and so its hash) through the description.
 */
function microModel(fill = 'x', size = 300) {
    return tfliteModel({
        input: { shape: [1, 3, 40], type: INT8, scale: 0.1015625, zeroPoint: -128 },
        output: { shape: [1, 1], type: UINT8, scale: 0.00390625 },
        description: String(fill).repeat(size),
    });
}

/** Shaped like an openWakeWord classifier: 16 speech embeddings of 96 values in, one float out. */
function openWakeWordModel() {
    return tfliteModel({ input: { shape: [1, 16, 96], type: FLOAT32 }, output: { shape: [1, 1], type: FLOAT32 } });
}

module.exports = { tfliteModel, microModel, openWakeWordModel, FLOAT32, UINT8, INT8 };
