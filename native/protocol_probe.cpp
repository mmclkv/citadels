#include <cctype>
#include <iostream>
#include <sstream>
#include <string>

#include "json_value.hpp"

namespace {

bool hasField(const std::string& line, const std::string& field,
             const std::string& value) {
  return line.find("\"" + field + "\":\"" + value + "\"") != std::string::npos;
}

bool readStringField(const std::string& line, const std::string& field,
                     std::string& out) {
  const std::string marker = "\"" + field + "\":\"";
  const size_t begin = line.find(marker);
  if (begin == std::string::npos) return false;
  const size_t value_begin = begin + marker.size();
  const size_t value_end = line.find('"', value_begin);
  if (value_end == std::string::npos) return false;
  out = line.substr(value_begin, value_end - value_begin);
  return true;
}

size_t arraySize(const std::string& line, const std::string& field) {
  const std::string marker = "\"" + field + "\":[";
  const size_t begin = line.find(marker);
  if (begin == std::string::npos) return 0;
  const size_t end = line.find(']', begin + marker.size());
  if (end == std::string::npos) return 0;
  const std::string body = line.substr(begin + marker.size(), end - begin - marker.size());
  if (body.find_first_not_of(" \t\r\n") == std::string::npos) return 0;
  size_t depth = 0, count = 1;
  bool in_string = false, escaped = false;
  for (const char ch : body) {
    if (escaped) { escaped = false; continue; }
    if (ch == '\\' && in_string) { escaped = true; continue; }
    if (ch == '"') { in_string = !in_string; continue; }
    if (in_string) continue;
    if (ch == '{' || ch == '[') ++depth;
    else if (ch == '}' || ch == ']') { if (depth) --depth; }
    else if (ch == ',' && depth == 0) ++count;
  }
  return count;
}

void emitError(const std::string& id, const std::string& message) {
  std::cout << "{\"v\":1,\"t\":\"error\",\"id\":\"" << id
            << "\",\"error\":\"" << message << "\"}\n" << std::flush;
}

}  // namespace

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string id;
    try {
      const auto request = citadels::native::parse_json(line);
      if (!request.is_object()) throw std::runtime_error("请求必须是对象");
      const auto* idValue = request.get("id");
      const auto* version = request.get("v");
      const auto* type = request.get("t");
      const auto* state = request.get("state");
      const auto* actions = request.get("legalActions");
      const auto* hash = request.get("stateHash");
      if (!idValue || !idValue->is_string()) throw std::runtime_error("missing id");
      id = idValue->as_string();
      if (!version || !version->is_number() || version->as_number() != 1 ||
          !type || !type->is_string() || type->as_string() != "search")
        throw std::runtime_error("unsupported protocol request");
      if (!state || !state->is_object()) throw std::runtime_error("state must be a complete object");
      const auto* players = state->get("players");
      if (!players || !players->is_array()) throw std::runtime_error("state.players must be an array");
      if (!actions || !actions->is_array()) throw std::runtime_error("legalActions must be an array");
      if (!hash || !hash->is_string() || hash->as_string().size() != 64)
        throw std::runtime_error("invalid stateHash");
      std::cout << "{\"v\":1,\"t\":\"search_result\",\"id\":\"" << id
                << "\",\"policy\":[";
      for (size_t i = 0; i < actions->as_array().size(); ++i) {
        if (i) std::cout << ',';
        std::cout << (actions->as_array().empty() ? 0.0 : 1.0 / actions->as_array().size());
      }
      std::cout << "],\"value\":0,\"backend\":\"native-probe\"}\n" << std::flush;
    } catch (const std::exception& error) {
      emitError(id, error.what());
    }
  }
  return 0;
}
