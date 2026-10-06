#pragma once

#include <algorithm>
#include <map>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

#include "state_loader.hpp"

namespace citadels::native {

inline bool character_allowed(const JsonValue& character, int players) {
  return !(players <= 2 && bool_field(character, "twoPlayerBan")) &&
         int_field(character, "smallBan", 0) <= players;
}

inline std::vector<std::string> select_character_ids(const JsonValue& catalog,
                                                     int players,
                                                     const std::string& mode,
                                                     JsRng& rng) {
  const auto& definitions = required_field(catalog, "characters");
  if (!definitions.is_array()) throw std::runtime_error("catalog.characters 必须是数组");
  std::vector<const JsonValue*> pool;
  if (mode == "base") {
    for (const auto& item : definitions.as_array())
      if (string_field(item, "version") == "base") pool.push_back(&item);
  } else if (mode == "dark") {
    static const std::vector<std::string> dark = {
      "witch", "blackmailer", "wizard", "emperor", "abbot", "alchemist",
      "navigator", "diplomat", "tax_collector"};
    for (const auto& id : dark) {
      const auto it = std::find_if(definitions.as_array().begin(), definitions.as_array().end(),
        [&](const JsonValue& item) { return string_field(item, "id") == id; });
      if (it != definitions.as_array().end()) pool.push_back(&*it);
    }
  } else {
    std::map<int, std::vector<const JsonValue*>> by_number;
    for (const auto& item : definitions.as_array())
      if (character_allowed(item, players)) by_number[int_field(item, "num")].push_back(&item);
    for (const auto& [number, variants] : by_number) {
      (void)number;
      if (!variants.empty()) {
        const size_t choice = static_cast<size_t>(rng.next() * variants.size());
        pool.push_back(variants[std::min(choice, variants.size() - 1)]);
      }
    }
  }

  std::vector<const JsonValue*> selected;
  for (const auto* item : pool) if (character_allowed(*item, players)) selected.push_back(item);
  std::stable_sort(selected.begin(), selected.end(), [](const JsonValue* left, const JsonValue* right) {
    return int_field(*left, "num") < int_field(*right, "num");
  });
  if (players <= 3 && selected.size() > 8) {
    std::vector<const JsonValue*> unique;
    std::unordered_set<int> seen;
    for (const auto* item : selected)
      if (seen.insert(int_field(*item, "num")).second) unique.push_back(item);
    unique.resize(std::min<size_t>(8, unique.size()));
    selected = std::move(unique);
  }
  if (selected.size() < static_cast<size_t>(players + 1)) {
    std::unordered_set<int> used;
    for (const auto* item : selected) used.insert(int_field(*item, "num"));
    std::vector<const JsonValue*> extras;
    for (const auto& item : definitions.as_array())
      if (character_allowed(item, players) && !used.count(int_field(item, "num"))) extras.push_back(&item);
    std::stable_sort(extras.begin(), extras.end(), [](const JsonValue* left, const JsonValue* right) {
      return int_field(*left, "num") > int_field(*right, "num");
    });
    for (const auto* item : extras) {
      if (selected.size() >= static_cast<size_t>(players + 1)) break;
      if (used.insert(int_field(*item, "num")).second) selected.push_back(item);
    }
    std::stable_sort(selected.begin(), selected.end(), [](const JsonValue* left, const JsonValue* right) {
      return int_field(*left, "num") < int_field(*right, "num");
    });
  }
  std::vector<std::string> ids;
  ids.reserve(selected.size());
  for (const auto* item : selected) ids.push_back(string_field(*item, "id"));
  return ids;
}

inline NativeGameState create_native_game(const JsonValue& request) {
  const auto& seats = required_field(request, "seats");
  const auto& catalog = required_field(request, "catalog");
  if (!seats.is_array() || seats.as_array().size() < 2 || seats.as_array().size() > 8)
    throw std::runtime_error("C++ 引擎开局需要 2 至 8 个座位");
  const int player_count = static_cast<int>(seats.as_array().size());
  NativeGameState state;
  const double seed = number_field(request, "seed", 1);
  if (seed < 0 || seed > 4294967295.0 || std::floor(seed) != seed)
    throw std::runtime_error("Game seed must be a uint32");
  state.rng = JsRng(static_cast<uint32_t>(seed));
  state.end_districts = int_field(request, "endDistricts", 8);
  state.round = 0;
  state.first_to_finish = -1;

  for (size_t i = 0; i < seats.as_array().size(); ++i) {
    const auto& source = seats.as_array()[i];
    NativePlayer player;
    player.id = string_field(source, "id");
    player.name = string_field(source, "name", player.id);
    player.seat = static_cast<int>(i);
    player.gold = int_field(request, "startingGold", 2);
    player.is_bot = bool_field(source, "isBot");
    player.bot_type = string_field(source, "botType", "npc");
    player.bot_level = string_field(source, "botLevel", "hard");
    if (player.bot_type == "cfr") { player.bot_type = "npc"; player.bot_level = "hard"; }
    if (player.bot_type == "npc-easy" || player.bot_type == "npc-normal" || player.bot_type == "npc-hard") {
      player.bot_level = player.bot_type.substr(4); player.bot_type = "npc";
    }
    player.connected = true;
    state.players.push_back(std::move(player));
  }
  const int crown = std::clamp(int_field(request, "initialCrownSeat", 0), 0, player_count - 1);
  state.players[crown].has_crown = true;
  state.char_deck = select_character_ids(catalog, player_count,
      string_field(request, "charSetMode", "base"), state.rng);

  const auto& district_definitions = required_field(catalog, "districts");
  if (!district_definitions.is_array()) throw std::runtime_error("catalog.districts 必须是数组");
  std::vector<DistrictCard> deck;
  for (const auto& definition : district_definitions.as_array()) {
    const int count = std::max(0, int_field(definition, "count"));
    for (int i = 0; i < count; ++i) {
      DistrictCard card;
      card.uid = "d" + std::to_string(deck.size());
      card.name = string_field(definition, "name");
      card.en = string_field(definition, "en");
      card.desc = string_field(definition, "desc");
      card.color = string_field(definition, "color");
      card.cost = int_field(definition, "cost");
      card.score_value = int_field(definition, "scoreValue", card.cost);
      const auto* purple = definition.get("purple");
      if (purple && purple->is_object()) {
        card.purple_effect = string_field(*purple, "effect");
        card.score_as = int_field(*purple, "scoreAs");
      }
      deck.push_back(std::move(card));
    }
  }
  for (size_t i = deck.size(); i > 1; --i) {
    const size_t selected = static_cast<size_t>(state.rng.next() * static_cast<double>(i));
    std::swap(deck[i - 1], deck[std::min(selected, i - 1)]);
  }
  state.deck.load(std::move(deck), {});
  const int starting_hand = std::max(0, int_field(request, "startingHand", 4));
  for (auto& player : state.players) {
    player.hand = state.deck.draw(starting_hand, state.rng);
    player.hand_count = static_cast<int>(player.hand.size());
  }
  if (!state.begin_next_round()) throw std::runtime_error("C++ 引擎无法初始化第一轮选角");
  return state;
}

}  // namespace citadels::native
