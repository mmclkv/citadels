#include <iostream>
#include <string>

#include "json_value.hpp"

namespace {

bool field(const std::string& line, const char* name, std::string& value) {
  const std::string marker = std::string("\"") + name + "\":\"";
  const size_t begin = line.find(marker);
  if (begin == std::string::npos) return false;
  const size_t valueBegin = begin + marker.size();
  const size_t valueEnd = line.find('"', valueBegin);
  if (valueEnd == std::string::npos) return false;
  value = line.substr(valueBegin, valueEnd - valueBegin);
  return true;
}

bool validHash(const std::string& value) { return value.size() == 64; }

size_t countHashFields(const std::string& line, const char* name) {
  const std::string marker = std::string("\"") + name + "\":\"";
  size_t count = 0;
  size_t offset = 0;
  while ((offset = line.find(marker, offset)) != std::string::npos) {
    const size_t begin = offset + marker.size();
    const size_t end = line.find('"', begin);
    if (end == std::string::npos || end - begin != 64) return 0;
    ++count;
    offset = end + 1;
  }
  return count;
}

void emit(const std::string& id, bool ok, const std::string& error = {}) {
  std::cout << "{\"v\":1,\"t\":\"replay_result\",\"id\":\"" << id
            << "\",\"ok\":" << (ok ? "true" : "false");
  if (!ok) std::cout << ",\"error\":\"" << error << "\"";
  std::cout << "}\n" << std::flush;
}

}  // namespace

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string id, initial;
    try {
      const auto request = citadels::native::parse_json(line);
      if (!request.is_object()) throw std::runtime_error("unsupported replay protocol");
      const auto* idValue = request.get("id");
      const auto* version = request.get("v");
      const auto* type = request.get("t");
      const auto* initialState = request.get("initialState");
      const auto* records = request.get("records");
      const auto* initialHash = request.get("initialHash");
      if (!idValue || !idValue->is_string()) throw std::runtime_error("missing id");
      id = idValue->as_string();
      if (!version || !version->is_number() || version->as_number() != 1 ||
          !type || !type->is_string() || type->as_string() != "replay")
        throw std::runtime_error("unsupported replay protocol");
      if (!initialState || !initialState->is_object()) throw std::runtime_error("missing initialState");
      const auto* players = initialState->get("players");
      if (!players || !players->is_array() || players->as_array().empty())
        throw std::runtime_error("initialState.players must be a non-empty array");
      if (!records || !records->is_array()) throw std::runtime_error("records must be an array");
      if (!initialHash || !initialHash->is_string() || !validHash(initialHash->as_string()))
        throw std::runtime_error("invalid initialHash");
      for (const auto& record : records->as_array()) {
        if (!record.is_object()) throw std::runtime_error("replay record must be an object");
        const auto* player = record.get("playerId");
        const auto* action = record.get("action");
        const auto* before = record.get("beforeHash");
        const auto* after = record.get("afterHash");
        if (!player || !player->is_string() || !action || !action->is_object() ||
            !before || !before->is_string() || !validHash(before->as_string()) ||
            !after || !after->is_string() || !validHash(after->as_string()))
          throw std::runtime_error("invalid replay record");
      }
      emit(id, true);
    } catch (const std::exception& error) {
      emit(id, false, error.what());
    }
  }
  return 0;
}
