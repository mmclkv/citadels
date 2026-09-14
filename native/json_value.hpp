#pragma once

#include <cctype>
#include <cmath>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>

namespace citadels::native {

// 小型、无第三方依赖的 JSON 读取器，仅用于 native NDJSON 控制协议。
// 解析结果保留完整对象树，规则层可按需读取字段，不会把 JS 状态压缩成摘要。
class JsonValue {
 public:
  using Object = std::unordered_map<std::string, JsonValue>;
  using Array = std::vector<JsonValue>;
  using Storage = std::variant<std::nullptr_t, bool, double, std::string, Array, Object>;

  JsonValue() : value_(nullptr) {}
  explicit JsonValue(Storage value) : value_(std::move(value)) {}

  bool is_null() const { return std::holds_alternative<std::nullptr_t>(value_); }
  bool is_bool() const { return std::holds_alternative<bool>(value_); }
  bool is_number() const { return std::holds_alternative<double>(value_); }
  bool is_string() const { return std::holds_alternative<std::string>(value_); }
  bool is_array() const { return std::holds_alternative<Array>(value_); }
  bool is_object() const { return std::holds_alternative<Object>(value_); }
  bool as_bool() const { return std::get<bool>(value_); }
  double as_number() const { return std::get<double>(value_); }
  const std::string& as_string() const { return std::get<std::string>(value_); }
  const Array& as_array() const { return std::get<Array>(value_); }
  const Object& as_object() const { return std::get<Object>(value_); }
  const JsonValue* get(const std::string& key) const {
    if (!is_object()) return nullptr;
    const auto& object = as_object();
    const auto it = object.find(key);
    return it == object.end() ? nullptr : &it->second;
  }

 private:
  Storage value_;
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& text) : text_(text) {}

  JsonValue parse() {
    skip_space();
    JsonValue result = parse_value();
    skip_space();
    if (pos_ != text_.size()) fail("JSON 尾部存在多余字符");
    return result;
  }

 private:
  JsonValue parse_value() {
    skip_space();
    if (pos_ >= text_.size()) fail("JSON 值缺失");
    switch (text_[pos_]) {
      case 'n': return parse_literal("null", JsonValue{});
      case 't': return parse_literal("true", JsonValue(JsonValue::Storage(true)));
      case 'f': return parse_literal("false", JsonValue(JsonValue::Storage(false)));
      case '"': return JsonValue(JsonValue::Storage(parse_string()));
      case '[': return parse_array();
      case '{': return parse_object();
      default:
        if (text_[pos_] == '-' || std::isdigit(static_cast<unsigned char>(text_[pos_])))
          return JsonValue(JsonValue::Storage(parse_number()));
        fail("无法识别 JSON 值");
    }
    return {};
  }

  JsonValue parse_literal(const char* literal, JsonValue result) {
    const std::string word(literal);
    if (text_.compare(pos_, word.size(), word) != 0) fail("非法 JSON 字面量");
    pos_ += word.size();
    return result;
  }

  std::string parse_string() {
    if (text_[pos_++] != '"') fail("字符串必须以引号开始");
    std::string result;
    while (pos_ < text_.size()) {
      const char ch = text_[pos_++];
      if (ch == '"') return result;
      if (ch == '\\') {
        if (pos_ >= text_.size()) fail("字符串转义不完整");
        const char escaped = text_[pos_++];
        switch (escaped) {
          case '"': result.push_back('"'); break;
          case '\\': result.push_back('\\'); break;
          case '/': result.push_back('/'); break;
          case 'b': result.push_back('\b'); break;
          case 'f': result.push_back('\f'); break;
          case 'n': result.push_back('\n'); break;
          case 'r': result.push_back('\r'); break;
          case 't': result.push_back('\t'); break;
          case 'u': fail("暂不支持 unicode 转义");
          default: fail("未知字符串转义");
        }
      } else {
        if (static_cast<unsigned char>(ch) < 0x20) fail("字符串包含控制字符");
        result.push_back(ch);
      }
    }
    fail("字符串未闭合");
    return {};
  }

  double parse_number() {
    const size_t begin = pos_;
    if (text_[pos_] == '-') ++pos_;
    if (pos_ >= text_.size() || !std::isdigit(static_cast<unsigned char>(text_[pos_])))
      fail("数字格式错误");
    if (text_[pos_] == '0') ++pos_;
    else while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) ++pos_;
    if (pos_ < text_.size() && text_[pos_] == '.') {
      ++pos_;
      if (pos_ >= text_.size() || !std::isdigit(static_cast<unsigned char>(text_[pos_]))) fail("小数格式错误");
      while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) ++pos_;
    }
    if (pos_ < text_.size() && (text_[pos_] == 'e' || text_[pos_] == 'E')) {
      ++pos_;
      if (pos_ < text_.size() && (text_[pos_] == '+' || text_[pos_] == '-')) ++pos_;
      if (pos_ >= text_.size() || !std::isdigit(static_cast<unsigned char>(text_[pos_]))) fail("指数格式错误");
      while (pos_ < text_.size() && std::isdigit(static_cast<unsigned char>(text_[pos_]))) ++pos_;
    }
    const double value = std::stod(text_.substr(begin, pos_ - begin));
    if (!std::isfinite(value)) fail("数字超出范围");
    return value;
  }

  JsonValue parse_array() {
    ++pos_;
    JsonValue::Array result;
    skip_space();
    if (consume(']')) return JsonValue(JsonValue::Storage(std::move(result)));
    while (true) {
      result.push_back(parse_value());
      skip_space();
      if (consume(']')) break;
      if (!consume(',')) fail("数组缺少逗号");
    }
    return JsonValue(JsonValue::Storage(std::move(result)));
  }

  JsonValue parse_object() {
    ++pos_;
    JsonValue::Object result;
    skip_space();
    if (consume('}')) return JsonValue(JsonValue::Storage(std::move(result)));
    while (true) {
      skip_space();
      if (pos_ >= text_.size() || text_[pos_] != '"') fail("对象键必须是字符串");
      std::string key = parse_string();
      skip_space();
      if (!consume(':')) fail("对象键后缺少冒号");
      result[std::move(key)] = parse_value();
      skip_space();
      if (consume('}')) break;
      if (!consume(',')) fail("对象缺少逗号");
    }
    return JsonValue(JsonValue::Storage(std::move(result)));
  }

  bool consume(char expected) {
    if (pos_ < text_.size() && text_[pos_] == expected) { ++pos_; return true; }
    return false;
  }
  void skip_space() { while (pos_ < text_.size() && std::isspace(static_cast<unsigned char>(text_[pos_]))) ++pos_; }
  [[noreturn]] void fail(const char* message) const { throw std::runtime_error(message); }

  const std::string& text_;
  size_t pos_ = 0;
};

inline JsonValue parse_json(const std::string& text) { return JsonParser(text).parse(); }

}  // namespace citadels::native
