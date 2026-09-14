#pragma once

#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "json_value.hpp"
#include "game_state.hpp"

namespace citadels::native {

inline const JsonValue& required_field(const JsonValue& object, const char* name) {
  const auto* value = object.get(name);
  if (!value) throw std::runtime_error(std::string("状态缺少字段: ") + name);
  return *value;
}

inline std::string string_field(const JsonValue& object, const char* name,
                                const std::string& fallback = {}) {
  const auto* value = object.get(name);
  return value && value->is_string() ? value->as_string() : fallback;
}

inline int int_field(const JsonValue& object, const char* name, int fallback = 0) {
  const auto* value = object.get(name);
  return value && value->is_number() ? static_cast<int>(value->as_number()) : fallback;
}

inline bool bool_field(const JsonValue& object, const char* name, bool fallback = false) {
  const auto* value = object.get(name);
  return value && value->is_bool() ? value->as_bool() : fallback;
}

inline DistrictCard load_card(const JsonValue& value) {
  if (!value.is_object()) throw std::runtime_error("卡牌必须是对象");
  return {string_field(value, "uid"), string_field(value, "color"), int_field(value, "cost")};
}

inline std::vector<DistrictCard> load_cards(const JsonValue& value) {
  if (!value.is_array()) throw std::runtime_error("卡牌列表必须是数组");
  std::vector<DistrictCard> cards;
  cards.reserve(value.as_array().size());
  for (const auto& card : value.as_array()) cards.push_back(load_card(card));
  return cards;
}

inline NativeDistrict load_city_card(const JsonValue& value) {
  if (!value.is_object()) throw std::runtime_error("城市建筑必须是对象");
  NativeDistrict district;
  district.card = load_card(value);
  district.name = string_field(value, "name");
  const auto* purple = value.get("purple");
  if (purple && purple->is_object()) district.effect = string_field(*purple, "effect");
  return district;
}

inline NativeGameState load_native_state(const JsonValue& snapshot) {
  if (!snapshot.is_object()) throw std::runtime_error("state 必须是对象");
  NativeGameState state;
  state.round = int_field(snapshot, "round", 1);
  state.rng = JsRng(static_cast<uint32_t>(int_field(snapshot, "rngState")));
  const auto* config = snapshot.get("config");
  if (config && config->is_object()) state.end_districts = int_field(*config, "endDistricts", 8);

  const auto& players = required_field(snapshot, "players");
  if (!players.is_array() || players.as_array().empty()) throw std::runtime_error("state.players 不能为空");
  state.players.reserve(players.as_array().size());
  for (const auto& value : players.as_array()) {
    if (!value.is_object()) throw std::runtime_error("玩家必须是对象");
    NativePlayer player;
    player.id = string_field(value, "id");
    player.gold = int_field(value, "gold");
    player.has_crown = bool_field(value, "hasCrown");
    const auto* chars = value.get("chars");
    if (chars && chars->is_array()) {
      for (const auto& role : chars->as_array()) if (role.is_string()) player.role_id = role.as_string();
    }
    const auto* hand = value.get("hand");
    if (hand) player.hand = load_cards(*hand);
    const auto* city = value.get("city");
    if (city && city->is_array()) {
      player.city.reserve(city->as_array().size());
      for (const auto& building : city->as_array()) player.city.push_back(load_city_card(building));
    }
    state.players.push_back(std::move(player));
  }

  std::vector<DistrictCard> deck;
  std::vector<DistrictCard> discard;
  const auto* deck_value = snapshot.get("deck");
  const auto* discard_value = snapshot.get("discard");
  if (deck_value) deck = load_cards(*deck_value);
  if (discard_value) discard = load_cards(*discard_value);
  state.deck.load(std::move(deck), std::move(discard));

  const auto* turn = snapshot.get("turn");
  if (turn && turn->is_object()) {
    state.active_player = int_field(*turn, "playerIdx", -1);
    state.resources_taken = bool_field(*turn, "takenResources");
    state.builds = int_field(*turn, "builds");
  }
  if (state.active_player < 0 || state.active_player >= static_cast<int>(state.players.size()))
    state.active_player = 0;
  return state;
}

inline NativeGameState load_native_state_line(const std::string& line) {
  const auto request = parse_json(line);
  const auto* state = request.get("state");
  if (!state) throw std::runtime_error("协议请求缺少 state");
  return load_native_state(*state);
}

}  // namespace citadels::native
