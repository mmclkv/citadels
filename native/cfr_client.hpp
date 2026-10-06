#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <cstdlib>
#include <chrono>
#include <stdexcept>
#include <string>
#include <random>
#ifdef _WIN32
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>
#endif
#include "cfr_information.hpp"
#include "json_value.hpp"
#include "state_writer.hpp"

namespace citadels::native {

// Direct game-process -> policy-process IPC. Only already-masked information
// and semantic legal actions cross this boundary, never NativeGameState.
class CfrClient {
 public:
  CfrClient() = default;
  CfrClient(const CfrClient&) = delete;
  CfrClient& operator=(const CfrClient&) = delete;
  ~CfrClient() { close(); }
  struct Decision { int selected = -1; bool hit = false, configured = false; };
  Decision decide(const std::string& info, const CfrActionSet& actions, uint32_t seed) {
    if (actions.keys.empty()) return {};
    if (!running_) start();
    std::ostringstream request;
    request << "{\"mode\":\"infer\",\"seed\":" << seed << ",\"information\":";
    write_json_string(request, info); request << ",\"actions\":"; write_json_strings(request, actions.keys);
    request << "}\n";
    const auto response = parse_json(exchange(request.str()));
    if (string_field(response, "t") == "error") throw std::runtime_error("CFR worker: " + string_field(response, "error"));
    const int group = int_field(response, "selected", -1);
    if (group < 0 || group >= static_cast<int>(actions.indices.size())) throw std::runtime_error("Invalid CFR policy response");
    // Equivalent physical copies share a strategy action; choose a transport
    // representative uniformly, rather than overweighting duplicated buttons.
    std::mt19937 rng(seed ^ 0xCFA12345u);
    const auto& copies = actions.indices[group];
    return {static_cast<int>(copies[std::uniform_int_distribution<size_t>(0, copies.size()-1)(rng)]),
            bool_field(response, "hit"), bool_field(response, "configured")};
  }
 private:
  void start() {
    const char* executable = std::getenv("CITADELS_CFR_WORKER");
    if (!executable || !*executable) throw std::runtime_error("CITADELS_CFR_WORKER is not configured");
#ifdef _WIN32
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE child_read = nullptr, child_write = nullptr;
    if (!CreatePipe(&output_, &child_write, &security, 0) || !CreatePipe(&child_read, &input_, &security, 0)) {
      if (output_) CloseHandle(output_); if (child_write) CloseHandle(child_write);
      if (child_read) CloseHandle(child_read); if (input_) CloseHandle(input_);
      input_ = output_ = nullptr; throw std::runtime_error("Cannot create CFR pipes");
    }
    SetHandleInformation(output_, HANDLE_FLAG_INHERIT, 0); SetHandleInformation(input_, HANDLE_FLAG_INHERIT, 0);
    const int count = MultiByteToWideChar(CP_UTF8, 0, executable, -1, nullptr, 0);
    std::wstring path(count, L'\0'); MultiByteToWideChar(CP_UTF8, 0, executable, -1, path.data(), count); path.pop_back();
    std::wstring command = L"\"" + path + L"\"";
    STARTUPINFOW startup{sizeof(STARTUPINFOW)}; startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = child_read; startup.hStdOutput = child_write; startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child{};
    const bool ok = CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                   nullptr, nullptr, &startup, &child);
    CloseHandle(child_read); CloseHandle(child_write);
    if (!ok) { CloseHandle(input_); CloseHandle(output_); input_ = output_ = nullptr; throw std::runtime_error("Cannot start CFR worker"); }
    process_ = child.hProcess; CloseHandle(child.hThread);
#else
    int in[2], out[2];
    if (pipe(in)) throw std::runtime_error("Cannot create CFR input pipe");
    if (pipe(out)) { ::close(in[0]); ::close(in[1]); throw std::runtime_error("Cannot create CFR output pipe"); }
    process_ = fork();
    if (process_ == 0) {
      dup2(in[0], STDIN_FILENO); dup2(out[1], STDOUT_FILENO);
      ::close(in[0]); ::close(in[1]); ::close(out[0]); ::close(out[1]);
      execl(executable, executable, static_cast<char*>(nullptr)); _exit(127);
    }
    ::close(in[0]); ::close(out[1]);
    if (process_ < 0) { ::close(in[1]); ::close(out[0]); throw std::runtime_error("Cannot fork CFR worker"); }
    input_ = in[1]; output_ = out[0]; signal(SIGPIPE, SIG_IGN);
#endif
    running_ = true;
  }
  std::string exchange(const std::string& line) {
    size_t written = 0;
    while (written < line.size()) {
#ifdef _WIN32
      DWORD n = 0;
      if (!WriteFile(input_, line.data()+written, static_cast<DWORD>(std::min<size_t>(line.size()-written, 65536)), &n, nullptr) || !n)
        throw std::runtime_error("CFR pipe write failed");
#else
      const auto n = write(input_, line.data()+written, line.size()-written);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) throw std::runtime_error("CFR pipe write failed");
#endif
      written += n;
    }
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(60);
    std::string response;
    for (;;) {
      if (std::chrono::steady_clock::now() >= deadline) throw std::runtime_error("CFR response timed out");
      char ch = 0;
#ifdef _WIN32
      DWORD available = 0, n = 0;
      if (!PeekNamedPipe(output_, nullptr, 0, nullptr, &available, nullptr)) throw std::runtime_error("CFR worker exited");
      if (!available) { Sleep(1); continue; }
      if (!ReadFile(output_, &ch, 1, &n, nullptr) || !n) throw std::runtime_error("CFR worker exited");
#else
      pollfd p{output_, POLLIN, 0}; const int ready = poll(&p, 1, 100);
      if (ready < 0 && errno == EINTR) continue;
      if (ready < 0) throw std::runtime_error("CFR poll failed");
      if (!ready) continue;
      const auto n = read(output_, &ch, 1);
      if (n < 0 && errno == EINTR) continue;
      if (n != 1) throw std::runtime_error("CFR worker exited");
#endif
      if (ch == '\n') return response;
      response.push_back(ch);
    }
  }
  void close() noexcept {
    if (!running_) return;
#ifdef _WIN32
    CloseHandle(input_); CloseHandle(output_);
    if (WaitForSingleObject(process_, 3000) == WAIT_TIMEOUT) TerminateProcess(process_, 1);
    CloseHandle(process_); input_ = output_ = process_ = nullptr;
#else
    ::close(input_); ::close(output_);
    int status = 0; bool reaped = false;
    for (int i = 0; i < 300; ++i) {
      if (waitpid(process_, &status, WNOHANG) == process_) { reaped = true; break; }
      usleep(10000);
    }
    if (!reaped) { kill(process_, SIGKILL); waitpid(process_, &status, 0); }
#endif
    running_ = false;
  }
  bool running_ = false;
#ifdef _WIN32
  HANDLE input_ = nullptr, output_ = nullptr, process_ = nullptr;
#else
  int input_ = -1, output_ = -1; pid_t process_ = -1;
#endif
};
}  // namespace citadels::native
