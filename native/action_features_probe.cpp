#include <iomanip>
#include <iostream>

#include "json_value.hpp"
#include "neural_evaluator.hpp"
#include "state_loader.hpp"

using namespace citadels::native;

int main() {
  std::string line;
  if (!std::getline(std::cin, line)) return 2;
  try {
    const auto value = parse_json(line);
    const auto parsed = action_type_from_string(string_field(value, "type"));
    auto name = string_field(value, "name");
    if (name.empty()) name = string_field(value, "charId");
    if (name.empty()) name = string_field(value, "mode");
    auto effect = string_field(value, "effect");
    if (effect.empty() && value.get("use")) effect = bool_field(value, "use") ? "use" : "skip";
    NativeSearchAction action;
    action.type = parsed.value_or(ActionType::EndTurn);
    action.uid = string_field(value, "uid");
    action.name = name;
    action.effect = effect;
    action.target = string_field(value, "target");
    action.selected_uids = string_array_field(value, "uids");
    action.secondary_uid = string_field(value, "secondaryUid");
    if (action.secondary_uid.empty()) action.secondary_uid = string_field(value, "discardUid");
    if (action.secondary_uid.empty()) action.secondary_uid = string_field(value, "cardUid");
    const auto vector = encode_network_action(action);
    std::cout << std::setprecision(9);
    for (size_t i = 0; i < vector.size(); ++i) {
      if (i) std::cout << ',';
      std::cout << vector[i];
    }
    std::cout << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
