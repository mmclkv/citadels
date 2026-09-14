#include <cctype>
#include <iostream>
#include <sstream>
#include <string>

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
    if (!readStringField(line, "id", id)) { emitError("", "missing id"); continue; }
    if (line.find("\"v\":1") == std::string::npos ||
        !hasField(line, "t", "search")) {
      emitError(id, "unsupported protocol request");
      continue;
    }
    std::string hash;
    if (!readStringField(line, "stateHash", hash) || hash.size() != 64) {
      emitError(id, "invalid stateHash");
      continue;
    }
    const size_t actions = arraySize(line, "legalActions");
    std::cout << "{\"v\":1,\"t\":\"search_result\",\"id\":\"" << id
              << "\",\"policy\":[";
    for (size_t i = 0; i < actions; ++i) {
      if (i) std::cout << ',';
      std::cout << (actions ? 1.0 / static_cast<double>(actions) : 0.0);
    }
    std::cout << "],\"value\":0,\"backend\":\"native-probe\"}\n" << std::flush;
  }
  return 0;
}
