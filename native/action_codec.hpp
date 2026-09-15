#pragma once

#include <optional>
#include <string_view>

namespace citadels::native {

// 动作名与 src/engine.js 的 getAvailableActions/applyAction 保持一一对应。
enum class ActionType {
  AbilitySkip,
  Ability,
  ArtistDone,
  Build,
  ChooseCards,
  ChooseChar,
  ChooseDistrict,
  ChoosePlayer,
  ConfirmRound,
  DraftDiscard,
  DraftPick,
  DrawKeep,
  EmperorCrown,
  EmperorTake,
  EndTurn,
  Income,
  Lab,
  MagicianMode,
  MonkResource,
  MonkTake,
  Museum,
  NavigatorBonus,
  PendingBack,
  ProphetGive,
  Reaction,
  ScholarPick,
  Smithy,
  TakeCards,
  TakeGold
};

struct Action {
  ActionType type;
  std::string_view uid;
  std::string_view target;
  std::string_view mode;
  int num = -1;
  int gold = -1;
  int cards = -1;
  bool use = false;
};

inline std::optional<ActionType> action_type_from_string(std::string_view value) {
#define CITADELS_ACTION(name, text) if (value == text) return ActionType::name;
  CITADELS_ACTION(AbilitySkip, "ability_skip")
  CITADELS_ACTION(Ability, "ability")
  CITADELS_ACTION(ArtistDone, "artist_done")
  CITADELS_ACTION(Build, "build")
  CITADELS_ACTION(ChooseCards, "choose_cards")
  CITADELS_ACTION(ChooseChar, "choose_char")
  CITADELS_ACTION(ChooseDistrict, "choose_district")
  CITADELS_ACTION(ChoosePlayer, "choose_player")
  CITADELS_ACTION(ConfirmRound, "confirm_round")
  CITADELS_ACTION(DraftDiscard, "draft_discard")
  CITADELS_ACTION(DraftPick, "draft_pick")
  CITADELS_ACTION(DrawKeep, "draw_keep")
  CITADELS_ACTION(EmperorCrown, "emperor_crown")
  CITADELS_ACTION(EmperorTake, "emperor_take")
  CITADELS_ACTION(EndTurn, "end_turn")
  CITADELS_ACTION(Income, "income")
  CITADELS_ACTION(Lab, "lab")
  CITADELS_ACTION(MagicianMode, "magician_mode")
  CITADELS_ACTION(MonkResource, "monk_resource")
  CITADELS_ACTION(MonkTake, "monk_take")
  CITADELS_ACTION(Museum, "museum")
  CITADELS_ACTION(NavigatorBonus, "navigator_bonus")
  CITADELS_ACTION(PendingBack, "pending_back")
  CITADELS_ACTION(ProphetGive, "prophet_give")
  CITADELS_ACTION(Reaction, "reaction")
  CITADELS_ACTION(ScholarPick, "scholar_pick")
  CITADELS_ACTION(Smithy, "smithy")
  CITADELS_ACTION(TakeCards, "take_cards")
  CITADELS_ACTION(TakeGold, "take_gold")
#undef CITADELS_ACTION
  return std::nullopt;
}

inline std::string_view action_type_name(ActionType type) {
  switch (type) {
    case ActionType::AbilitySkip: return "ability_skip";
    case ActionType::Ability: return "ability";
    case ActionType::ArtistDone: return "artist_done";
    case ActionType::Build: return "build";
    case ActionType::ChooseCards: return "choose_cards";
    case ActionType::ChooseChar: return "choose_char";
    case ActionType::ChooseDistrict: return "choose_district";
    case ActionType::ChoosePlayer: return "choose_player";
    case ActionType::ConfirmRound: return "confirm_round";
    case ActionType::DraftDiscard: return "draft_discard";
    case ActionType::DraftPick: return "draft_pick";
    case ActionType::DrawKeep: return "draw_keep";
    case ActionType::EmperorCrown: return "emperor_crown";
    case ActionType::EmperorTake: return "emperor_take";
    case ActionType::EndTurn: return "end_turn";
    case ActionType::Income: return "income";
    case ActionType::Lab: return "lab";
    case ActionType::MagicianMode: return "magician_mode";
    case ActionType::MonkResource: return "monk_resource";
    case ActionType::MonkTake: return "monk_take";
    case ActionType::Museum: return "museum";
    case ActionType::NavigatorBonus: return "navigator_bonus";
    case ActionType::PendingBack: return "pending_back";
    case ActionType::ProphetGive: return "prophet_give";
    case ActionType::Reaction: return "reaction";
    case ActionType::ScholarPick: return "scholar_pick";
    case ActionType::Smithy: return "smithy";
    case ActionType::TakeCards: return "take_cards";
    case ActionType::TakeGold: return "take_gold";
  }
  return {};
}

}  // namespace citadels::native
