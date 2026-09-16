#pragma once

#include <optional>
#include <string_view>

namespace citadels::native {

// 动作名与 src/engine.js 的 getAvailableActions/applyAction 保持一一对应。
enum class ActionType {
  AbbotResource,
  AbilitySkip,
  Ability,
  ArtistDone,
  BlackmailerBribe,
  BlackmailerRefuse,
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
  MagistrateSigned,
  MonkResource,
  MonkTake,
  Museum,
  NavigatorBonus,
  PendingBack,
  ProphetGive,
  Reaction,
  ScholarPick,
  Smithy,
  SpyColor,
  SpyTarget,
  TakeCards,
  TakeGold,
  TaxCollect,
  WizardBuild,
  WizardCard,
  WizardTake,
  WizardTarget
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
  CITADELS_ACTION(AbbotResource, "abbot_resource")
  CITADELS_ACTION(AbilitySkip, "ability_skip")
  CITADELS_ACTION(Ability, "ability")
  CITADELS_ACTION(ArtistDone, "artist_done")
  CITADELS_ACTION(BlackmailerBribe, "blackmailer_bribe")
  CITADELS_ACTION(BlackmailerRefuse, "blackmailer_refuse")
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
  CITADELS_ACTION(MagistrateSigned, "magistrate_signed")
  CITADELS_ACTION(MonkResource, "monk_resource")
  CITADELS_ACTION(MonkTake, "monk_take")
  CITADELS_ACTION(Museum, "museum")
  CITADELS_ACTION(NavigatorBonus, "navigator_bonus")
  CITADELS_ACTION(PendingBack, "pending_back")
  CITADELS_ACTION(ProphetGive, "prophet_give")
  CITADELS_ACTION(Reaction, "reaction")
  CITADELS_ACTION(ScholarPick, "scholar_pick")
  CITADELS_ACTION(Smithy, "smithy")
  CITADELS_ACTION(SpyColor, "spy_color")
  CITADELS_ACTION(SpyTarget, "spy_target")
  CITADELS_ACTION(TakeCards, "take_cards")
  CITADELS_ACTION(TakeGold, "take_gold")
  CITADELS_ACTION(TaxCollect, "tax_collect")
  CITADELS_ACTION(WizardBuild, "wizard_build")
  CITADELS_ACTION(WizardCard, "wizard_card")
  CITADELS_ACTION(WizardTake, "wizard_take")
  CITADELS_ACTION(WizardTarget, "wizard_target")
#undef CITADELS_ACTION
  return std::nullopt;
}

inline std::string_view action_type_name(ActionType type) {
  switch (type) {
    case ActionType::AbbotResource: return "abbot_resource";
    case ActionType::AbilitySkip: return "ability_skip";
    case ActionType::Ability: return "ability";
    case ActionType::ArtistDone: return "artist_done";
    case ActionType::BlackmailerBribe: return "blackmailer_bribe";
    case ActionType::BlackmailerRefuse: return "blackmailer_refuse";
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
    case ActionType::MagistrateSigned: return "magistrate_signed";
    case ActionType::MonkResource: return "monk_resource";
    case ActionType::MonkTake: return "monk_take";
    case ActionType::Museum: return "museum";
    case ActionType::NavigatorBonus: return "navigator_bonus";
    case ActionType::PendingBack: return "pending_back";
    case ActionType::ProphetGive: return "prophet_give";
    case ActionType::Reaction: return "reaction";
    case ActionType::ScholarPick: return "scholar_pick";
    case ActionType::Smithy: return "smithy";
    case ActionType::SpyColor: return "spy_color";
    case ActionType::SpyTarget: return "spy_target";
    case ActionType::TakeCards: return "take_cards";
    case ActionType::TakeGold: return "take_gold";
    case ActionType::TaxCollect: return "tax_collect";
    case ActionType::WizardBuild: return "wizard_build";
    case ActionType::WizardCard: return "wizard_card";
    case ActionType::WizardTake: return "wizard_take";
    case ActionType::WizardTarget: return "wizard_target";
  }
  return {};
}

}  // namespace citadels::native
