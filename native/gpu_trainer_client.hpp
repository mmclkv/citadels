#pragma once

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "batch_evaluator.hpp"

namespace citadels::native {

constexpr uint32_t kGpuBinaryMagic = 0x31425443;  // "CTB1" little-endian.
constexpr uint32_t kGpuBinaryBatchEval = 1;
constexpr uint32_t kGpuBinaryBatchResult = 2;
constexpr uint32_t kGpuBinaryReload = 3;
constexpr uint32_t kGpuBinaryClose = 4;
constexpr uint32_t kGpuBinaryError = 0xffffffffu;

inline void append_u32(std::vector<uint8_t>& output, uint32_t value) {
  const size_t offset = output.size();
  output.resize(offset + sizeof(value));
  std::memcpy(output.data() + offset, &value, sizeof(value));
}

inline void append_bytes(std::vector<uint8_t>& output, const void* data, size_t size) {
  const size_t offset = output.size();
  output.resize(offset + size);
  if (size) std::memcpy(output.data() + offset, data, size);
}

inline uint32_t read_u32(const std::vector<uint8_t>& input, size_t& offset) {
  if (offset + sizeof(uint32_t) > input.size()) throw std::runtime_error("binary GPU response truncated");
  uint32_t value = 0;
  std::memcpy(&value, input.data() + offset, sizeof(value));
  offset += sizeof(value);
  return value;
}

inline float read_f32(const std::vector<uint8_t>& input, size_t& offset) {
  if (offset + sizeof(float) > input.size()) throw std::runtime_error("binary GPU response truncated");
  float value = 0.0f;
  std::memcpy(&value, input.data() + offset, sizeof(value));
  offset += sizeof(value);
  return value;
}

inline std::vector<uint8_t> encode_binary_frame(const std::vector<uint8_t>& payload) {
  std::vector<uint8_t> frame;
  frame.reserve(8 + payload.size());
  append_u32(frame, kGpuBinaryMagic);
  append_u32(frame, static_cast<uint32_t>(payload.size()));
  append_bytes(frame, payload.data(), payload.size());
  return frame;
}

inline std::vector<uint8_t> encode_binary_batch_eval_request(
    const std::vector<std::vector<float>>& states,
    const std::vector<std::vector<std::vector<float>>>& actions) {
  if (states.size() != actions.size()) throw std::invalid_argument("binary batch 状态和动作数量不一致");
  if (states.empty()) throw std::invalid_argument("binary batch 不能为空");
  const uint32_t state_size = static_cast<uint32_t>(states.front().size());
  uint32_t action_size = 0;
  for (const auto& state : states)
    if (state.size() != state_size) throw std::invalid_argument("binary batch 状态维度不一致");
  for (const auto& group : actions) for (const auto& action : group) {
    if (action_size == 0) action_size = static_cast<uint32_t>(action.size());
    if (action.size() != action_size) throw std::invalid_argument("binary batch 动作维度不一致");
  }
  if (action_size == 0) action_size = 64;
  std::vector<uint8_t> payload;
  append_u32(payload, kGpuBinaryBatchEval);
  append_u32(payload, static_cast<uint32_t>(states.size()));
  append_u32(payload, state_size);
  append_u32(payload, action_size);
  for (const auto& group : actions) append_u32(payload, static_cast<uint32_t>(group.size()));
  for (const auto& state : states) append_bytes(payload, state.data(), state.size() * sizeof(float));
  for (const auto& group : actions)
    for (const auto& action : group) append_bytes(payload, action.data(), action.size() * sizeof(float));
  return encode_binary_frame(payload);
}

inline std::vector<uint8_t> encode_binary_reload_request(const std::string& model_path) {
  std::vector<uint8_t> payload;
  append_u32(payload, kGpuBinaryReload);
  append_u32(payload, static_cast<uint32_t>(model_path.size()));
  append_bytes(payload, model_path.data(), model_path.size());
  return encode_binary_frame(payload);
}

inline std::vector<uint8_t> encode_binary_close_request() {
  std::vector<uint8_t> payload;
  append_u32(payload, kGpuBinaryClose);
  return encode_binary_frame(payload);
}

inline BatchEvaluationResult decode_binary_batch_eval_response(
    const std::vector<uint8_t>& payload,
    const std::vector<size_t>& action_counts) {
  size_t offset = 0;
  const uint32_t command = read_u32(payload, offset);
  if (command == kGpuBinaryError) {
    const uint32_t length = read_u32(payload, offset);
    if (offset + length > payload.size()) throw std::runtime_error("binary GPU error truncated");
    throw std::runtime_error("gpu_trainer binary batch_eval 失败: " +
      std::string(reinterpret_cast<const char*>(payload.data() + offset), length));
  }
  if (command != kGpuBinaryBatchResult) throw std::runtime_error("binary GPU 返回类型错误");
  const uint32_t count = read_u32(payload, offset);
  if (count != action_counts.size()) throw std::runtime_error("binary GPU 批次大小不匹配");
  BatchEvaluationResult result;
  result.policies.reserve(count);
  result.values.reserve(count);
  result.value_vectors.reserve(count);
  for (uint32_t i = 0; i < count; ++i) {
    const uint32_t action_count = read_u32(payload, offset);
    if (action_count != action_counts[i]) throw std::runtime_error("binary GPU 动作数量不匹配");
    std::vector<float> policy;
    policy.reserve(action_count);
    for (uint32_t j = 0; j < action_count; ++j) policy.push_back(read_f32(payload, offset));
    result.policies.push_back(std::move(policy));
    std::array<float, 8> values{};
    const size_t remaining = static_cast<size_t>(count - i);
    const bool has_vector_payload = payload.size() - offset >= remaining * 8 * sizeof(float);
    if (has_vector_payload) {
      for (float& value : values) value = read_f32(payload, offset);
    } else {
      values[0] = read_f32(payload, offset);
    }
    result.value_vectors.push_back(values);
    result.values.push_back(values[0]);
  }
  if (offset != payload.size()) throw std::runtime_error("binary GPU 返回包含多余数据");
  return result;
}

inline std::string json_escape(const std::string& value) {
  std::string out;
  for (char ch : value) {
    if (ch == '\\' || ch == '"') out.push_back('\\');
    if (ch == '\n') { out += "\\n"; continue; }
    if (ch == '\r') { out += "\\r"; continue; }
    out.push_back(ch);
  }
  return out;
}

inline void append_json_vector(std::ostringstream& out, const std::vector<float>& values) {
  out << '[';
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out << ',';
    out << values[i];
  }
  out << ']';
}

inline std::string encode_batch_eval_request(
    const std::vector<std::vector<float>>& states,
    const std::vector<std::vector<std::vector<float>>>& actions,
    const std::string& profile = "balanced") {
  if (states.size() != actions.size()) throw std::invalid_argument("batch 请求状态和动作数量不一致");
  std::ostringstream out;
  out << "{\"cmd\":\"batch_eval\",\"profile\":\""
      << json_escape(profile) << "\",\"stateVectors\":[";
  for (size_t i = 0; i < states.size(); ++i) {
    if (i) out << ',';
    append_json_vector(out, states[i]);
  }
  out << "],\"actionVectorsList\":[";
  for (size_t i = 0; i < actions.size(); ++i) {
    if (i) out << ',';
    out << '[';
    for (size_t j = 0; j < actions[i].size(); ++j) {
      if (j) out << ',';
      append_json_vector(out, actions[i][j]);
    }
    out << ']';
  }
  out << "]}\n";
  return out.str();
}

inline size_t find_json_array_end(const std::string& text, size_t begin) {
  size_t depth = 0;
  bool quoted = false, escaped = false;
  for (size_t i = begin; i < text.size(); ++i) {
    const char ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && ch == '\\') { escaped = true; continue; }
    if (ch == '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch == '[') ++depth;
    if (ch == ']' && --depth == 0) return i;
  }
  throw std::runtime_error("JSON 数组未闭合");
}

inline std::vector<float> parse_numbers(const std::string& text, size_t begin, size_t end) {
  std::vector<float> values;
  size_t i = begin;
  while (i < end) {
    while (i < end && !std::isdigit(static_cast<unsigned char>(text[i])) && text[i] != '-' && text[i] != '.') ++i;
    if (i >= end) break;
    size_t next = i + 1;
    while (next < end && (std::isdigit(static_cast<unsigned char>(text[next])) ||
                          text[next] == '-' || text[next] == '+' || text[next] == '.' ||
                          text[next] == 'e' || text[next] == 'E')) ++next;
    try { values.push_back(std::stof(text.substr(i, next - i))); } catch (...) {}
    i = next;
  }
  return values;
}

inline BatchEvaluationResult decode_batch_eval_response(const std::string& response,
                                                        const std::vector<size_t>& action_counts) {
  const size_t ok_key = response.find("\"ok\"");
  const size_t ok_true = ok_key == std::string::npos ? std::string::npos
                                                     : response.find("true", ok_key);
  if (ok_key == std::string::npos || ok_true == std::string::npos)
    throw std::runtime_error("gpu_trainer batch_eval 返回失败: " + response);
  const size_t policy_key = response.find("\"probsList\"");
  const size_t outer_begin = policy_key == std::string::npos
      ? std::string::npos : response.find('[', policy_key);
  if (outer_begin == std::string::npos) throw std::runtime_error("batch_eval 缺少 probsList");
  const size_t outer_end = find_json_array_end(response, outer_begin);
  BatchEvaluationResult result;
  size_t cursor = outer_begin + 1;
  for (size_t row = 0; row < action_counts.size(); ++row) {
    while (cursor < outer_end && response[cursor] != '[') ++cursor;
    if (cursor >= outer_end) throw std::runtime_error("batch_eval probsList 行数不足");
    const size_t row_end = find_json_array_end(response, cursor);
    result.policies.push_back(parse_numbers(response, cursor + 1, row_end));
    cursor = row_end + 1;
  }
  const size_t vector_key = response.find("\"valueVectors\"");
  const size_t vectors_start = vector_key == std::string::npos
      ? std::string::npos : response.find('[', vector_key);
  if (vectors_start != std::string::npos) {
    const size_t vectors_end = find_json_array_end(response, vectors_start);
    size_t value_cursor = vectors_start + 1;
    for (size_t row = 0; row < action_counts.size(); ++row) {
      while (value_cursor < vectors_end && response[value_cursor] != '[') ++value_cursor;
      if (value_cursor >= vectors_end) throw std::runtime_error("batch_eval valueVectors 行数不足");
      const size_t row_end = find_json_array_end(response, value_cursor);
      const auto numbers = parse_numbers(response, value_cursor + 1, row_end);
      std::array<float, 8> values{};
      for (size_t i = 0; i < numbers.size() && i < values.size(); ++i) values[i] = numbers[i];
      result.value_vectors.push_back(values);
      result.values.push_back(values[0]);
      value_cursor = row_end + 1;
    }
  } else {
    const size_t value_key = response.find("\"values\"");
    const size_t values_start = value_key == std::string::npos
        ? std::string::npos : response.find('[', value_key);
    if (values_start == std::string::npos) throw std::runtime_error("batch_eval 缺少 values");
    const size_t values_end = find_json_array_end(response, values_start);
    result.values = parse_numbers(response, values_start + 1, values_end);
    result.value_vectors.resize(result.values.size());
    for (size_t i = 0; i < result.values.size(); ++i) result.value_vectors[i][0] = result.values[i];
  }
  if (result.values.size() != action_counts.size() || result.policies.size() != action_counts.size())
    throw std::runtime_error("batch_eval 返回批次大小不匹配");
  for (size_t i = 0; i < action_counts.size(); ++i)
    if (result.policies[i].size() != action_counts[i]) throw std::runtime_error("batch_eval 动作数量不匹配");
  return result;
}

// Windows 实现使用匿名双向管道；Linux/macOS 保留协议编码接口，便于后续替换 socket/pipe。
class GpuTrainerClient {
 public:
  GpuTrainerClient(std::string python, std::string script)
      : python_(std::move(python)), script_(std::move(script)) {}
  ~GpuTrainerClient() { close(); }

  void start(const std::string& profile, const std::string& model_path,
             float learning_rate, const std::string& device,
             const std::string& protocol = "json");
  BatchEvaluationResult evaluate(const std::vector<std::vector<float>>& states,
                                 const std::vector<std::vector<std::vector<float>>>& actions,
                                 const std::string& profile);
  void reload_model(const std::string& model_path);
  void close();

 private:
  std::string request(const std::string& line);
  std::vector<uint8_t> request_binary(const std::vector<uint8_t>& frame);
  std::string python_, script_;
  bool binary_protocol_ = false;
  bool running_ = false;
#ifdef _WIN32
  void* stdin_write_ = nullptr;
  void* stdout_read_ = nullptr;
  void* process_ = nullptr;
#endif
};

}  // namespace citadels::native

#ifdef _WIN32
#include <windows.h>

namespace citadels::native {

inline std::wstring wide_path(const std::string& path) {
  if (path.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, result.data(), size);
  result.pop_back();
  return result;
}

inline void GpuTrainerClient::start(const std::string& profile, const std::string& model_path,
                                    float learning_rate, const std::string& device,
                                    const std::string& protocol) {
  if (running_) return;
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE child_out_read = nullptr, child_out_write = nullptr;
  HANDLE child_in_read = nullptr, child_in_write = nullptr;
  if (!CreatePipe(&child_out_read, &child_out_write, &security, 0) ||
      !CreatePipe(&child_in_read, &child_in_write, &security, 0))
    throw std::runtime_error("无法创建 gpu_trainer 管道");
  SetHandleInformation(child_out_read, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(child_in_write, HANDLE_FLAG_INHERIT, 0);
  std::wstring command = L"\"" + wide_path(python_) + L"\" -u \"" + wide_path(script_) + L"\"";
  STARTUPINFOW startup{sizeof(STARTUPINFOW)};
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = child_in_read; startup.hStdOutput = child_out_write; startup.hStdError = child_out_write;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup, &process)) {
    CloseHandle(child_out_read); CloseHandle(child_out_write);
    CloseHandle(child_in_read); CloseHandle(child_in_write);
    throw std::runtime_error("无法启动 gpu_trainer.py");
  }
  CloseHandle(child_out_write); CloseHandle(child_in_read);
  stdout_read_ = child_out_read; stdin_write_ = child_in_write; process_ = process.hProcess;
  CloseHandle(process.hThread); running_ = true;
  std::ostringstream init;
  binary_protocol_ = protocol == "binary";
  init << "{\"cmd\":\"init\",\"profile\":\"" << json_escape(profile)
       << "\",\"learningRate\":" << learning_rate << ",\"device\":\""
       << json_escape(device) << "\",\"modelPath\":\"" << json_escape(model_path)
       << "\"" << (binary_protocol_ ? ",\"protocol\":\"binary\"" : "") << "}\n";
  request(init.str());
}

inline std::string GpuTrainerClient::request(const std::string& line) {
  if (!running_) throw std::runtime_error("gpu_trainer 客户端未启动");
  DWORD written = 0;
  if (!WriteFile(static_cast<HANDLE>(stdin_write_), line.data(), static_cast<DWORD>(line.size()), &written, nullptr))
    throw std::runtime_error("写入 gpu_trainer 失败");
  std::string response;
  char ch = 0; DWORD read = 0;
  while (ReadFile(static_cast<HANDLE>(stdout_read_), &ch, 1, &read, nullptr) && read == 1) {
    if (ch == '\n') break;
    response.push_back(ch);
  }
  if (response.empty()) throw std::runtime_error("gpu_trainer 未返回响应");
  return response;
}

inline BatchEvaluationResult GpuTrainerClient::evaluate(
    const std::vector<std::vector<float>>& states,
    const std::vector<std::vector<std::vector<float>>>& actions,
    const std::string& profile) {
  if (binary_protocol_) {
    std::vector<size_t> counts;
    counts.reserve(actions.size());
    for (const auto& group : actions) counts.push_back(group.size());
    return decode_binary_batch_eval_response(
      request_binary(encode_binary_batch_eval_request(states, actions)), counts);
  }
  std::vector<size_t> counts;
  for (const auto& group : actions) counts.push_back(group.size());
  return decode_batch_eval_response(request(encode_batch_eval_request(states, actions, profile)), counts);
}

inline void GpuTrainerClient::reload_model(const std::string& model_path) {
  if (binary_protocol_) {
    request_binary(encode_binary_reload_request(model_path));
    return;
  }
  request("{\"cmd\":\"reload\",\"modelPath\":\"" + json_escape(model_path) + "\"}\n");
}

inline void GpuTrainerClient::close() {
  if (!running_) return;
  try {
    if (binary_protocol_) request_binary(encode_binary_close_request());
    else request("{\"cmd\":\"close\"}\n");
  } catch (...) {}
  CloseHandle(static_cast<HANDLE>(stdin_write_)); CloseHandle(static_cast<HANDLE>(stdout_read_));
  TerminateProcess(static_cast<HANDLE>(process_), 0); CloseHandle(static_cast<HANDLE>(process_));
  stdin_write_ = stdout_read_ = process_ = nullptr; running_ = false;
}

inline std::vector<uint8_t> GpuTrainerClient::request_binary(const std::vector<uint8_t>& frame) {
  if (!running_) throw std::runtime_error("gpu_trainer 客户端未启动");
  const HANDLE input = static_cast<HANDLE>(stdin_write_);
  const HANDLE output = static_cast<HANDLE>(stdout_read_);
  size_t written_total = 0;
  while (written_total < frame.size()) {
    DWORD written = 0;
    const DWORD remaining = static_cast<DWORD>(std::min<size_t>(frame.size() - written_total, 1u << 20));
    if (!WriteFile(input, frame.data() + written_total, remaining, &written, nullptr) || written == 0)
      throw std::runtime_error("写入 gpu_trainer binary 请求失败");
    written_total += written;
  }
  uint8_t header[8]{};
  size_t read_total = 0;
  while (read_total < sizeof(header)) {
    DWORD read = 0;
    if (!ReadFile(output, header + read_total, static_cast<DWORD>(sizeof(header) - read_total), &read, nullptr) || read == 0)
      throw std::runtime_error("读取 gpu_trainer binary 响应失败");
    read_total += read;
  }
  uint32_t magic = 0, size = 0;
  std::memcpy(&magic, header, sizeof(magic));
  std::memcpy(&size, header + sizeof(magic), sizeof(size));
  if (magic != kGpuBinaryMagic || size > (1u << 28)) throw std::runtime_error("gpu_trainer binary 响应头错误");
  std::vector<uint8_t> payload(size);
  read_total = 0;
  while (read_total < payload.size()) {
    DWORD read = 0;
    if (!ReadFile(output, payload.data() + read_total,
                  static_cast<DWORD>(std::min<size_t>(payload.size() - read_total, 1u << 20)),
                  &read, nullptr) || read == 0)
      throw std::runtime_error("读取 gpu_trainer binary payload 失败");
    read_total += read;
  }
  return payload;
}

}  // namespace citadels::native
#else
namespace citadels::native {
inline std::vector<uint8_t> GpuTrainerClient::request_binary(const std::vector<uint8_t>&) {
  throw std::runtime_error("当前平台尚未实现 gpu_trainer binary 双向进程管道");
}
inline void GpuTrainerClient::start(const std::string&, const std::string&, float, const std::string&, const std::string&) {
  throw std::runtime_error("当前平台尚未实现 gpu_trainer 双向进程管道");
}
inline BatchEvaluationResult GpuTrainerClient::evaluate(const std::vector<std::vector<float>>&,
    const std::vector<std::vector<std::vector<float>>>&, const std::string&) {
  throw std::runtime_error("当前平台尚未实现 gpu_trainer 双向进程管道");
}
inline void GpuTrainerClient::reload_model(const std::string&) {
  throw std::runtime_error("当前平台尚未实现 gpu_trainer 双向进程管道");
}
inline void GpuTrainerClient::close() {}
}  // namespace citadels::native
#endif

namespace citadels::native {
inline BatchInferenceBackend make_gpu_batch_backend(
    const std::shared_ptr<GpuTrainerClient>& client, std::string profile) {
  return [client, profile = std::move(profile)](const auto& states, const auto& actions) {
    return client->evaluate(states, actions, profile);
  };
}
}  // namespace citadels::native
