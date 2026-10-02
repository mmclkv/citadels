#pragma once

#include <cstdint>

namespace citadels::native {

// Historical JavaScript-compatible 32-bit RNG retained by the archived native
// experiment to keep its recorded seeds reproducible across compilers.
class JsRng {
 public:
  JsRng() : state_(0) {}
  explicit JsRng(uint32_t seed) : state_(seed) {}

  uint32_t next_u32() {
    state_ += 0x6D2B79F5u;
    uint32_t t = state_;
    t = imul(t ^ (t >> 15), t | 1u);
    t ^= t + imul(t ^ (t >> 7), t | 61u);
    return t ^ (t >> 14);
  }

  double next() { return static_cast<double>(next_u32()) / 4294967296.0; }
  uint32_t state() const { return state_; }

 private:
  static uint32_t imul(uint32_t a, uint32_t b) {
    return static_cast<uint32_t>(static_cast<uint64_t>(a) * b);
  }

  uint32_t state_;
};

}  // namespace citadels::native
