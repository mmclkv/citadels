#include <iostream>
#include <string>

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
    if (!field(line, "id", id) || line.find("\"v\":1") == std::string::npos ||
        line.find("\"t\":\"replay\"") == std::string::npos) {
      emit(id, false, "unsupported replay protocol");
      continue;
    }
    if (!field(line, "initialHash", initial) || !validHash(initial)) {
      emit(id, false, "invalid initialHash");
      continue;
    }
    // Each trace record contributes one beforeHash and one afterHash. The
    // verifier checks the wire-level hash shape and count; rule semantics are
    // verified by JS replay until the native rule adapter is complete.
    const size_t before = countHashFields(line, "beforeHash");
    const size_t after = countHashFields(line, "afterHash");
    if (before != after) {
      emit(id, false, "incomplete action hash pair");
      continue;
    }
    emit(id, true);
  }
  return 0;
}
