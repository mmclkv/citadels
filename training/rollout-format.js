'use strict';

// rollout 二进制格式（Node → PyTorch 训练器 传递一批 PPO 样本）。
//
// 为什么不用 JSON：旧路径先把整批样本 Array.from 复制成 double 数组（约为
// float32 净负载的 2.5 倍），再 JSON.stringify 出一整条巨型字符串（256 局批次
// 实测 387 MB / 406 M 字符），再 gzipSync 出 Buffer。实测 256 局一批仅这一步
// 就在主进程里多驻留 2676 MB，且字符串长度逼近 V8 的 ~512 M 字符上限（再多
// 就抛 RangeError: Invalid string length）。换成扁平 float32 后，写入全程经一个
// chunkBytes 级别的复用缓冲分块落盘，单次分配有上界，文件里也不再带编码开销。
//
// 布局（小端，32 字节头 + 顺序块，无对齐填充）：
//
//   Header
//     0  magic         c[4]  'CTRL'
//     4  version       u32   = 1
//     8  rowCount      u32   样本条数
//    12  actionSlots   u32   全批合法动作总数（= sum(actionCounts)）
//    16  stateSize     u32   状态向量宽度
//    20  actionSize    u32   动作向量宽度
//    24  valueSlots    u32   价值头槽位数
//    28  piSlots       u32   带到 π 的行贡献的槽位总数（= sum(actionCounts)，仅限有 π 的行）
//
//   states            rowCount    × stateSize    f32
//   actionsFlat       actionSlots × actionSize   f32
//   actionCounts      rowCount                   i32
//   chosen            rowCount                   i32
//   oldProbs          rowCount                   f32
//   temperatures      rowCount                   f32
//   mctsValues        rowCount                   f32
//   piFlat            piSlots                    f32（只含带 π 的行，顺序拼接）
//   hasPi             rowCount                   u8（0/1）
//   oldValueVectors   rowCount    × valueSlots   f32
//   rewardVectors     rowCount    × valueSlots   f32
//   valueMasks        rowCount    × valueSlots   f32
//   mctsValueVectors  rowCount    × valueSlots   f32
//
// π 只写「带 π 的行」是为了让 Python 侧的 pi_offsets / pi_lengths 索引与旧
// JSON 读取器逐位一致（旧实现也是把有 π 的行单独 concat），避免训练侧改动。
//
// 缺省语义与旧 JSON 读取器逐条对齐（见 gpu_trainer.load_rollout 旧实现）：
//   oldValueVector -> [oldValue]，rewardVector -> [reward]，valueMask -> [1]，
//   三者都用 0 补齐到 valueSlots 再截断；temperature 缺省 1；pi 缺失的行
//   hasPi = 0，训练侧照旧用 chosen 的一热分布补齐。

const fs = require('fs');

const MAGIC = 'CTRL';
const VERSION = 1;
const HEADER_BYTES = 32;
const DEFAULT_VALUE_SLOTS = 8;
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;

const DTYPE_WIDTH = { f4: 4, i4: 4, u1: 1 };

function resolveSizes(transitions, fallback = {}) {
  let stateSize = 0, actionSize = 0, actionSlots = 0, piSlots = 0;
  for (const row of transitions) {
    if (!stateSize) stateSize = row.state.length;
    if (!actionSize && row.actions.length) actionSize = row.actions[0].length;
    const count = row.actions.length;
    actionSlots += count;
    if (row.pi && row.pi.length) piSlots += count;
  }
  return {
    stateSize: stateSize || fallback.stateSize || 0,
    actionSize: actionSize || fallback.actionSize || 0,
    valueSlots: fallback.valueSlots || DEFAULT_VALUE_SLOTS,
    actionSlots, piSlots
  };
}

// 顺序块的偏移表。导出给测试与 Python 读取器做「布局即契约」的交叉校验。
function planLayout(rowCount, sizes) {
  const blocks = [
    ['states', 'f4', rowCount * sizes.stateSize],
    ['actionsFlat', 'f4', sizes.actionSlots * sizes.actionSize],
    ['actionCounts', 'i4', rowCount],
    ['chosen', 'i4', rowCount],
    ['oldProbs', 'f4', rowCount],
    ['temperatures', 'f4', rowCount],
    ['mctsValues', 'f4', rowCount],
    ['piFlat', 'f4', sizes.piSlots],
    ['hasPi', 'u1', rowCount],
    ['oldValueVectors', 'f4', rowCount * sizes.valueSlots],
    ['rewardVectors', 'f4', rowCount * sizes.valueSlots],
    ['valueMasks', 'f4', rowCount * sizes.valueSlots],
    ['mctsValueVectors', 'f4', rowCount * sizes.valueSlots]
  ];
  let offset = HEADER_BYTES;
  return blocks.map(([name, dtype, count]) => {
    const bytes = count * DTYPE_WIDTH[dtype];
    const entry = { name, dtype, count, offset, bytes };
    offset += bytes;
    return entry;
  });
}

function encodeHeader({ version = VERSION, rowCount, actionSlots, stateSize, actionSize, valueSlots, piSlots }) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(rowCount, 8);
  header.writeUInt32LE(actionSlots, 12);
  header.writeUInt32LE(stateSize, 16);
  header.writeUInt32LE(actionSize, 20);
  header.writeUInt32LE(valueSlots, 24);
  header.writeUInt32LE(piSlots, 28);
  return header;
}

function readHeader(header) {
  if (header.length < HEADER_BYTES) throw new Error('rollout 头部长度不足');
  const magic = header.toString('ascii', 0, 4);
  if (magic !== MAGIC) throw new Error('rollout 魔数不匹配：' + magic);
  const version = header.readUInt32LE(4);
  if (version !== VERSION) throw new Error('rollout 版本不支持：' + version);
  return {
    version,
    rowCount: header.readUInt32LE(8),
    actionSlots: header.readUInt32LE(12),
    stateSize: header.readUInt32LE(16),
    actionSize: header.readUInt32LE(20),
    valueSlots: header.readUInt32LE(24),
    piSlots: header.readUInt32LE(28)
  };
}

// 整份文件共用这一个复用缓冲：不管多少行、多少块，进程里同时只存在
// chunkBytes 字节的写入缓冲 + 当前正在编码的单个小块。
class ChunkedByteWriter {
  constructor(chunkBytes, write) {
    this.chunkBytes = Math.max(4096, chunkBytes);
    this.write = write;
    this.buffer = Buffer.allocUnsafe(this.chunkBytes);
    this.filled = 0;
    this.maxWrite = 0;
    this.total = 0;
  }

  flush() {
    if (!this.filled) return;
    const slice = this.buffer.subarray(0, this.filled);
    this.maxWrite = Math.max(this.maxWrite, slice.length);
    this.total += slice.length;
    this.write(slice);
    this.filled = 0;
  }

  push(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.filled === this.chunkBytes) this.flush();
      const take = Math.min(this.chunkBytes - this.filled, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
    }
  }
}

// 把任意浮点序列压成恰好 width 个 float32 的字节视图（宽了截断、窄了补零）。
function f32Bytes(values, width) {
  const source = values instanceof Float32Array ? values : Float32Array.from(values || []);
  if (source.length === width) return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const out = new Float32Array(width);
  out.set(source.subarray(0, Math.min(width, source.length)));
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

// 复刻旧读取器对价值向量的缺省处理：优先用给定数组，否则用单值起源。
function fixedVector(row, field, fallbackField, slots) {
  const given = row[field];
  if (given && given.length) return f32Bytes(given, slots);
  const out = new Float32Array(slots);
  out[0] = Number(row[fallbackField]) || 0;
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function int32Bytes(values, rowCount) {
  const buffer = Buffer.allocUnsafe(rowCount * 4);
  for (let i = 0; i < rowCount; i++) buffer.writeInt32LE(Number(values[i]) | 0, i * 4);
  return buffer;
}

function uint8Bytes(values, rowCount) {
  const buffer = Buffer.allocUnsafe(rowCount);
  for (let i = 0; i < rowCount; i++) buffer[i] = values[i] ? 1 : 0;
  return buffer;
}

function f32Scalars(values, rowCount) {
  const buffer = Buffer.allocUnsafe(rowCount * 4);
  for (let i = 0; i < rowCount; i++) buffer.writeFloatLE(Number(values[i]) || 0, i * 4);
  return buffer;
}

/**
 * 把一批 transition 写成二进制 rollout 文件。
 * 返回 { bytes, rowCount, actionSlots, maxWrite, layout }；
 * maxWrite 是「单次交给 fs.writeSync 的最大字节数」，测试用它锁住
 * 「无论多少局都必须分块写」的性质。
 */
function writeRollout(file, transitions, options = {}) {
  const chunkBytes = options.chunkBytes || DEFAULT_CHUNK_BYTES;
  if (!transitions.length) throw new Error('rollout 为空');
  const sizes = resolveSizes(transitions, options);
  if (!sizes.stateSize || !sizes.actionSize) throw new Error('rollout 缺少有效的 state/action 宽度');
  const rowCount = transitions.length;
  const layout = planLayout(rowCount, sizes);
  const fd = fs.openSync(file, 'w');
  const writer = new ChunkedByteWriter(chunkBytes, buffer => fs.writeSync(fd, buffer, 0, buffer.length));
  try {
    writer.push(encodeHeader({
      rowCount, actionSlots: sizes.actionSlots, stateSize: sizes.stateSize,
      actionSize: sizes.actionSize, valueSlots: sizes.valueSlots, piSlots: sizes.piSlots
    }));
    for (const row of transitions) writer.push(f32Bytes(row.state, sizes.stateSize));
    for (const row of transitions) {
      for (const action of row.actions) writer.push(f32Bytes(action, sizes.actionSize));
    }
    writer.push(int32Bytes(transitions.map(row => row.actions.length), rowCount));
    writer.push(int32Bytes(transitions.map(row => row.chosen), rowCount));
    writer.push(f32Scalars(transitions.map(row => row.oldProb), rowCount));
    writer.push(f32Scalars(transitions.map(row => (row.temperature == null ? 1 : row.temperature)), rowCount));
    writer.push(f32Scalars(transitions.map(row => (row.mctsValue == null ? 0 : row.mctsValue)), rowCount));
    for (const row of transitions) {
      if (row.pi && row.pi.length) writer.push(f32Bytes(row.pi, row.actions.length));
    }
    writer.push(uint8Bytes(transitions.map(row => (row.pi && row.pi.length ? 1 : 0)), rowCount));
    for (const row of transitions) writer.push(fixedVector(row, 'oldValueVector', 'oldValue', sizes.valueSlots));
    for (const row of transitions) writer.push(fixedVector(row, 'rewardVector', 'reward', sizes.valueSlots));
    for (const row of transitions) {
      const mask = row.valueMask && row.valueMask.length ? row.valueMask : [1];
      writer.push(f32Bytes(mask, sizes.valueSlots));
    }
    for (const row of transitions) writer.push(fixedVector(row, 'mctsValueVector', 'mctsValue', sizes.valueSlots));
    writer.flush();
  } finally {
    fs.closeSync(fd);
  }
  const expected = layout.length
    ? layout[layout.length - 1].offset + layout[layout.length - 1].bytes : HEADER_BYTES;
  if (writer.total !== expected) {
    throw new Error('rollout 写入字节数不符：' + writer.total + ' != ' + expected);
  }
  return { bytes: writer.total, rowCount, actionSlots: sizes.actionSlots, maxWrite: writer.maxWrite, layout };
}

// JS 侧解码器：只给测试做「编码 → 解码」往返校验用，训练链路上不调用。
function decodeRollout(buffer) {
  const header = readHeader(buffer.subarray(0, HEADER_BYTES));
  const sizes = { stateSize: header.stateSize, actionSize: header.actionSize,
    valueSlots: header.valueSlots, actionSlots: header.actionSlots, piSlots: header.piSlots };
  const layout = planLayout(header.rowCount, sizes);
  const block = name => layout.find(entry => entry.name === name);
  const readF32 = name => {
    const target = block(name);
    const out = new Float32Array(target.count);
    for (let i = 0; i < target.count; i++) out[i] = buffer.readFloatLE(target.offset + i * 4);
    return out;
  };
  const readI32 = name => {
    const target = block(name);
    const out = new Int32Array(target.count);
    for (let i = 0; i < target.count; i++) out[i] = buffer.readInt32LE(target.offset + i * 4);
    return out;
  };
  const states = readF32('states');
  const actionsFlat = readF32('actionsFlat');
  const piFlat = readF32('piFlat');
  const counts = readI32('actionCounts');
  const chosen = readI32('chosen');
  const oldProbs = readF32('oldProbs');
  const temperatures = readF32('temperatures');
  const mctsValues = readF32('mctsValues');
  const hasPi = buffer.subarray(block('hasPi').offset, block('hasPi').offset + block('hasPi').count);
  const vectors = {
    oldValueVector: readF32('oldValueVectors'),
    rewardVector: readF32('rewardVectors'),
    valueMask: readF32('valueMasks'),
    mctsValueVector: readF32('mctsValueVectors')
  };
  const slots = header.valueSlots;
  const rows = [];
  let cursor = 0;
  let piCursor = 0;
  for (let i = 0; i < header.rowCount; i++) {
    const count = counts[i];
    const actions = [];
    for (let j = 0; j < count; j++) {
      const base = (cursor + j) * header.actionSize;
      actions.push(actionsFlat.subarray(base, base + header.actionSize));
    }
    const row = {
      state: states.subarray(i * header.stateSize, (i + 1) * header.stateSize),
      actions,
      chosen: chosen[i],
      oldProb: oldProbs[i],
      temperature: temperatures[i],
      mctsValue: mctsValues[i],
      pi: hasPi[i] ? piFlat.subarray(piCursor, piCursor + count) : null
    };
    if (hasPi[i]) piCursor += count;
    for (const [field, flat] of Object.entries(vectors)) {
      row[field] = flat.subarray(i * slots, (i + 1) * slots);
    }
    cursor += count;
    rows.push(row);
  }
  return { header, layout, rows };
}

module.exports = {
  MAGIC, VERSION, HEADER_BYTES, DEFAULT_VALUE_SLOTS, DEFAULT_CHUNK_BYTES, DTYPE_WIDTH,
  resolveSizes, planLayout, encodeHeader, readHeader, writeRollout, decodeRollout
};
