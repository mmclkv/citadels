#pragma once

#include <algorithm>
#include <cctype>
#include <functional>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "batch_evaluator.hpp"

namespace citadels::native {

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
  const size_t value_key = response.find("\"values\"");
  const size_t values_start = value_key == std::string::npos
      ? std::string::npos : response.find('[', value_key);
  if (values_start == std::string::npos) throw std::runtime_error("batch_eval 缺少 values");
  const size_t values_end = find_json_array_end(response, values_start);
  result.values = parse_numbers(response, values_start + 1, values_end);
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
             float learning_rate, const std::string& device);
  BatchEvaluationResult evaluate(const std::vector<std::vector<float>>& states,
                                 const std::vector<std::vector<std::vector<float>>>& actions,
                                 const std::string& profile);
  void reload_model(const std::string& model_path);
  void close();

 private:
  std::string request(const std::string& line);
  std::string python_, script_;
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
                                    float learning_rate, const std::string& device) {
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
  init << "{\"cmd\":\"init\",\"profile\":\"" << json_escape(profile)
       << "\",\"learningRate\":" << learning_rate << ",\"device\":\""
       << json_escape(device) << "\",\"modelPath\":\"" << json_escape(model_path) << "\"}\n";
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
  std::vector<size_t> counts;
  for (const auto& group : actions) counts.push_back(group.size());
  return decode_batch_eval_response(request(encode_batch_eval_request(states, actions, profile)), counts);
}

inline void GpuTrainerClient::reload_model(const std::string& model_path) {
  request("{\"cmd\":\"reload\",\"modelPath\":\"" + json_escape(model_path) + "\"}\n");
}

inline void GpuTrainerClient::close() {
  if (!running_) return;
  try { request("{\"cmd\":\"close\"}\n"); } catch (...) {}
  CloseHandle(static_cast<HANDLE>(stdin_write_)); CloseHandle(static_cast<HANDLE>(stdout_read_));
  TerminateProcess(static_cast<HANDLE>(process_), 0); CloseHandle(static_cast<HANDLE>(process_));
  stdin_write_ = stdout_read_ = process_ = nullptr; running_ = false;
}

}  // namespace citadels::native
#else
namespace citadels::native {
inline void GpuTrainerClient::start(const std::string&, const std::string&, float, const std::string&) {
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
