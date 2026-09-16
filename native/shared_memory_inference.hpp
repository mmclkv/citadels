#pragma once

// Windows named shared-memory request/response ring for the single GPU
// inference daemon. The payload format deliberately reuses the existing
// CTB1 binary batch protocol so the model-side decoder stays identical.

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "gpu_trainer_client.hpp"

#ifdef _WIN32
#include <windows.h>
#endif

namespace citadels::native {

constexpr uint32_t kSharedInferenceMagic = 0x314D5343;  // "CSM1"
constexpr uint32_t kSharedSlotFree = 0;
constexpr uint32_t kSharedSlotRequest = 1;
constexpr uint32_t kSharedSlotReady = 2;
constexpr uint32_t kSharedSlotResponse = 3;
constexpr size_t kSharedSlotHeaderBytes = 24;

struct SharedInferenceLayout {
  uint32_t magic = kSharedInferenceMagic;
  uint32_t version = 1;
  uint32_t slot_count = 8;
  uint32_t slot_bytes = 8 * 1024 * 1024;
};

#ifdef _WIN32
class SharedMemoryInferenceClient {
 public:
  SharedMemoryInferenceClient(std::string name, uint32_t slot_count = 8,
                              uint32_t slot_bytes = 8 * 1024 * 1024)
      : name_(std::move(name)), slot_count_(slot_count), slot_bytes_(slot_bytes) {
    mapping_ = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name_.c_str());
    if (!mapping_) throw std::runtime_error("无法打开共享内存推理队列：" + name_);
    view_ = static_cast<uint8_t*>(MapViewOfFile(static_cast<HANDLE>(mapping_), FILE_MAP_ALL_ACCESS, 0, 0, 0));
    if (!view_) { CloseHandle(static_cast<HANDLE>(mapping_)); mapping_ = nullptr; throw std::runtime_error("无法映射共享内存推理队列"); }
    auto* layout = reinterpret_cast<const SharedInferenceLayout*>(view_);
    if (layout->magic != kSharedInferenceMagic || layout->version != 1 ||
        layout->slot_count != slot_count_ || layout->slot_bytes != slot_bytes_)
      throw std::runtime_error("共享内存推理队列版本或布局不匹配");
  }

  ~SharedMemoryInferenceClient() { close(); }

  BatchEvaluationResult evaluate(const std::vector<std::vector<float>>& states,
                                 const std::vector<std::vector<std::vector<float>>>& actions) {
    // The pipe client uses CTB1 framing, while a shared-memory slot stores
    // only the command payload. Strip the frame before handing it to Python.
    const auto frame = encode_binary_batch_eval_request(states, actions);
    if (frame.size() < 8) throw std::runtime_error("共享内存推理请求帧不完整");
    uint32_t magic = 0, frame_size = 0;
    std::memcpy(&magic, frame.data(), sizeof(magic));
    std::memcpy(&frame_size, frame.data() + 4, sizeof(frame_size));
    if (magic != kGpuBinaryMagic || frame_size != frame.size() - 8)
      throw std::runtime_error("共享内存推理请求帧头错误");
    const std::vector<uint8_t> payload(frame.begin() + 8, frame.end());
    if (payload.size() > slot_bytes_ - kSharedSlotHeaderBytes)
      throw std::runtime_error("共享内存推理请求超过槽位容量");
    uint8_t* slot = nullptr;
    for (;;) {
      for (uint32_t i = 0; i < slot_count_; ++i) {
        auto* state = reinterpret_cast<volatile LONG*>(slot_ptr(i));
        if (InterlockedCompareExchange(state, kSharedSlotRequest, kSharedSlotFree) == kSharedSlotFree) {
          slot = slot_ptr(i); break;
        }
      }
      if (slot) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    write_u32(slot, 4, static_cast<uint32_t>(payload.size()));
    write_u32(slot, 8, 0);
    write_u32(slot, 12, next_id_++);
    std::memcpy(slot + kSharedSlotHeaderBytes, payload.data(), payload.size());
    MemoryBarrier();
    *reinterpret_cast<volatile LONG*>(slot) = kSharedSlotReady;
    for (;;) {
      if (*reinterpret_cast<volatile LONG*>(slot) == kSharedSlotResponse) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const uint32_t response_size = read_u32(slot, 8);
    if (response_size > slot_bytes_ - kSharedSlotHeaderBytes) {
      *reinterpret_cast<volatile LONG*>(slot) = kSharedSlotFree;
      throw std::runtime_error("共享内存推理响应超过槽位容量");
    }
    std::vector<uint8_t> response(response_size);
    std::memcpy(response.data(), slot + kSharedSlotHeaderBytes, response_size);
    MemoryBarrier();
    *reinterpret_cast<volatile LONG*>(slot) = kSharedSlotFree;
    std::vector<size_t> counts;
    counts.reserve(actions.size());
    for (const auto& group : actions) counts.push_back(group.size());
    return decode_binary_batch_eval_response(response, counts);
  }

  void close() {
    if (view_) UnmapViewOfFile(view_);
    if (mapping_) CloseHandle(static_cast<HANDLE>(mapping_));
    view_ = nullptr; mapping_ = nullptr;
  }

 private:
  uint8_t* slot_ptr(uint32_t index) const {
    return view_ + sizeof(SharedInferenceLayout) + static_cast<size_t>(index) * slot_bytes_;
  }
  static uint32_t read_u32(const uint8_t* slot, size_t offset) {
    uint32_t value = 0; std::memcpy(&value, slot + offset, sizeof(value)); return value;
  }
  static void write_u32(uint8_t* slot, size_t offset, uint32_t value) {
    std::memcpy(slot + offset, &value, sizeof(value));
  }
  std::string name_;
  uint32_t slot_count_ = 0, slot_bytes_ = 0, next_id_ = 1;
  void* mapping_ = nullptr;
  uint8_t* view_ = nullptr;
};
#else
class SharedMemoryInferenceClient {
 public:
  SharedMemoryInferenceClient(std::string, uint32_t = 8, uint32_t = 8 * 1024 * 1024) { throw std::runtime_error("共享内存推理队列当前仅支持 Windows"); }
  BatchEvaluationResult evaluate(const std::vector<std::vector<float>>&, const std::vector<std::vector<std::vector<float>>>&) { throw std::runtime_error("共享内存推理队列当前仅支持 Windows"); }
};
#endif

inline BatchInferenceBackend make_shared_memory_batch_backend(SharedMemoryInferenceClient& client) {
  return [&client](const auto& states, const auto& actions) { return client.evaluate(states, actions); };
}

}  // namespace citadels::native
