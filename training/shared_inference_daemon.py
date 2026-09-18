"""Single GPU inference daemon backed by a fixed-slot named shared memory ring."""
import argparse
import os
import struct
import sys
import time
from multiprocessing import shared_memory

# The bundled Python uses an isolated sys.path, so the script directory is not
# automatically importable when launched by Node with an absolute script path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gpu_trainer import PolicyValueNet, binary_batch_eval
import torch

# 实测（2026-09-18 诊断）：daemon 默认用满所有核做 intra-op 并行（6 核机器上
# 400-490% CPU），而 GPU 利用率只有 20-40% —— 小模型小批量下多线程互相拖累，
# 还把同机的 Node worker / 规则引擎饿死，自对弈需求一涨就整体饱和变慢。
# 收敛到 2 线程，核留给自对弈进程。
torch.set_num_threads(2)
try:
    torch.set_num_interop_threads(1)
except RuntimeError:
    pass  # 并行池已初始化后不允许再改，忽略即可

MAGIC = 0x314D5343  # CSM1
VERSION = 1
SLOT_FREE, SLOT_REQUEST, SLOT_READY, SLOT_RESPONSE = 0, 1, 2, 3
LAYOUT = 16
SLOT_HEADER = 24


def u32_get(buf, offset):
    return struct.unpack_from("<I", buf, offset)[0]


def u32_put(buf, offset, value):
    struct.pack_into("<I", buf, offset, value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--profile", default="balanced")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--model", required=True)
    parser.add_argument("--slots", type=int, default=8)
    parser.add_argument("--slot-bytes", type=int, default=8 * 1024 * 1024)
    args = parser.parse_args()
    total = LAYOUT + args.slots * args.slot_bytes
    shm = shared_memory.SharedMemory(name=args.name, create=True, size=total)
    buf = shm.buf
    struct.pack_into("<IIII", buf, 0, MAGIC, VERSION, args.slots, args.slot_bytes)
    for index in range(args.slots):
        base = LAYOUT + index * args.slot_bytes
        u32_put(buf, base, SLOT_FREE)
    use_cuda = torch.cuda.is_available() and args.device != "cpu"
    if args.device == "cuda" and not use_cuda:
        raise RuntimeError("已要求 CUDA，但 PyTorch 无法访问 CUDA")
    device = torch.device("cuda" if use_cuda else "cpu")
    model = PolicyValueNet(args.profile)
    model.load_flat(args.model)
    model.to(device)
    model.eval()
    model_stamp = (0, 0)

    def maybe_reload_model():
        nonlocal model_stamp
        try:
            stat = os.stat(args.model)
            stamp = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            return
        if stamp == model_stamp:
            return
        # The Node bridge replaces the live model atomically from the training
        # side.  Ignore a transient partial file and retry on the next poll.
        if stamp[1] == 0 or stamp[1] % 4:
            return
        try:
            model.load_flat(args.model)
            model.to(device)
            model.eval()
            model_stamp = stamp
            print("RELOADED", flush=True)
        except (OSError, RuntimeError, ValueError):
            return

    print("READY", flush=True)
    try:
        try:
            stat = os.stat(args.model)
            model_stamp = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            pass
        while True:
            maybe_reload_model()
            handled = False
            for index in range(args.slots):
                base = LAYOUT + index * args.slot_bytes
                if u32_get(buf, base) != SLOT_READY:
                    continue
                length = u32_get(buf, base + 4)
                if length > args.slot_bytes - SLOT_HEADER:
                    error_message = b"shared-memory request too large"
                    error = struct.pack("<II", 0xFFFFFFFF, len(error_message)) + error_message
                    buf[base + SLOT_HEADER:base + SLOT_HEADER + len(error)] = error
                    u32_put(buf, base + 8, len(error))
                    u32_put(buf, base, SLOT_RESPONSE)
                    continue
                payload = bytes(buf[base + SLOT_HEADER:base + SLOT_HEADER + length])
                try:
                    response = binary_batch_eval(payload, model, device)
                except Exception as error:
                    error_message = str(error).encode("utf-8", errors="replace")
                    response = struct.pack("<II", 0xFFFFFFFF, len(error_message)) + error_message
                buf[base + SLOT_HEADER:base + SLOT_HEADER + len(response)] = response
                u32_put(buf, base + 8, len(response))
                u32_put(buf, base, SLOT_RESPONSE)
                handled = True
            if not handled:
                time.sleep(0.0005)
    finally:
        del buf
        shm.close()
        try:
            shm.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
